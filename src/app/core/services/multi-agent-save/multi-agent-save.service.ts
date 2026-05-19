import { Injectable, inject } from '@angular/core';
import type { LLMContent } from '@hcs/llm-core';
import { MatDialog } from '@angular/material/dialog';
import { ContextBuilderService } from '../context-builder.service';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { GameStateService } from '../game-state.service';
import { AppConfigStore } from '../app-config-store';
import { FileUpdateParser } from '../file-update-parser';
import { AutoUpdateDialogComponent } from '@app/shared/components/auto-update-dialog/auto-update-dialog.component';
import { SaveProgressDialogComponent } from '@app/features/multi-agent-save/save-progress-dialog.component';
import { SaveAgentRunnerService } from './save-agent-runner.service';
import { SubToolDispatcherService } from './sub-tool-dispatcher.service';
import { SaveProgressTracker } from './progress/save-progress-tracker.service';
import { getLocale, getLangFolder } from '@app/core/constants/locales';
import { DEFAULT_PROFILE_ID, getProfileBasePath } from '@app/core/constants/prompt-profiles';
import { I18nService } from '@app/core/i18n';
import { MatSnackBar } from '@angular/material/snack-bar';

const MANIFEST_PROMPT_FILENAME = 'injection_save_manifest.md';

/**
 * Top-level orchestrator for the multi-agent save path.
 *
 * Compared to `GameEngineService.sendMessage`, multi-agent save:
 * - does NOT push a user message into chat history (save is not story)
 * - bypasses the legacy `intentInjection(SAVE)` prompt and uses
 *   `injection_save_manifest.md` instead
 * - emits no chat-side spinner; the modal `SaveProgressDialog` owns the UX
 * - reuses the existing cache state (provider + cachedContentName +
 *   systemInstruction from ContextBuilder snapshot) so the KV cache hits the
 *   same prefix the chat flow uses
 *
 * Flow:
 *   1. snapshot ContextBuilder + locale's prompt profile
 *   2. open SaveProgressDialog (mounted before first await so the user sees
 *      "Starting SaveAgent…" instead of a blank screen)
 *   3. SaveAgentRunner → manifest JSON
 *   4. SubToolDispatcher → concatenated `<save>` XML + per-tool progress entries
 *   5. FileUpdateParser → FileUpdate[]
 *   6. AutoUpdateDialog opens with the updates (existing flow handles apply)
 *
 * Failure path: any thrown error is surfaced as a snackbar and the progress
 * dialog stays open showing the failed entry. The user can close + retry.
 * No fallback to legacy in Phase 1.
 */
@Injectable({ providedIn: 'root' })
export class MultiAgentSaveService {
    private contextBuilder = inject(ContextBuilderService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private state = inject(GameStateService);
    private appConfig = inject(AppConfigStore);
    private saveAgent = inject(SaveAgentRunnerService);
    private dispatcher = inject(SubToolDispatcherService);
    private progress = inject(SaveProgressTracker);
    private dialog = inject(MatDialog);
    private i18n = inject(I18nService);
    private snackBar = inject(MatSnackBar);

    /**
     * Runs one save end-to-end. `userInput` is the raw text the user typed
     * after the `<save>` intent tag (range hint / correction request) — same
     * input that legacy save would get; the manifest prompt's `{{USER_INPUT}}`
     * placeholder substitution mirrors `ContextBuilder.augmentSingleCallHistory`.
     */
    async run(userInput: string): Promise<void> {
        this.progress.reset();
        this.progress.setRunning(true);

        const abortController = new AbortController();
        const dialogRef = this.dialog.open(SaveProgressDialogComponent, {
            width: '780px',
            maxWidth: '95vw',
            maxHeight: '90vh',
            disableClose: true,
            panelClass: 'save-progress-dialog-panel',
        });
        dialogRef.componentInstance.attachAbort(abortController);

        try {
            // 1. Snapshot turn context (provider, cache, history, language).
            const buildCtx = this.contextBuilder.snapshotForTurn();
            const provider = buildCtx.provider;
            if (!provider) throw new Error('No active LLM provider');

            const baseHistory = this.contextBuilder.getLLMHistory(buildCtx, /* forceFullContext */ true);
            const lang = buildCtx.outputLanguage || 'default';
            const profileId = this.state.activePromptProfile() || DEFAULT_PROFILE_ID;

            // 2. Load manifest prompt + compose user message.
            const manifestPrompt = await this.loadManifestPrompt(lang, profileId);
            const history = this.appendUserMessage(baseHistory, manifestPrompt, userInput);

            const omitKB = this.contextBuilder.shouldOmitKbFromSystemInstruction(buildCtx);
            const systemInstruction = this.contextBuilder.getEffectiveSystemInstruction(buildCtx, !omitKB);

            // 3. SaveAgent — emits the manifest JSON.
            const { manifest } = await this.saveAgent.run({
                provider,
                providerConfig: this.providerRegistry.getActiveConfig(),
                systemInstruction,
                cachedContentName: buildCtx.kbCacheName || undefined,
                history,
                signal: abortController.signal,
            });

            // 4. Dispatcher — fans out to mechanical handlers (Phase 1: inventoryDeltas only).
            const dispatchResult = this.dispatcher.dispatch({
                manifest,
                coreFilenames: getLocale(lang).coreFilenames,
                kbFiles: this.state.loadedFiles(),
            });

            // 5. Parse → FileUpdate[].
            if (!dispatchResult.xml) {
                // Nothing to apply — close progress dialog after the user reads it.
                this.snackBar.open(
                    this.i18n.translate('multiAgentSave.run.emptyResult'),
                    this.i18n.translate('ui.CLOSE'),
                    { duration: 6000 },
                );
                return;
            }

            const updates = FileUpdateParser.parse(dispatchResult.xml);

            // 6. Open AutoUpdateDialog. Close the progress dialog first so the
            //    user isn't looking at two stacked modals.
            this.progress.setRunning(false);
            dialogRef.close();

            this.dialog.open(AutoUpdateDialogComponent, {
                data: { updates },
                width: '90vw',
                maxWidth: '1200px',
                maxHeight: '90vh',
                panelClass: 'auto-update-dialog-panel',
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[MultiAgentSave] Run failed:', err);
            this.snackBar.open(
                this.i18n.translate('multiAgentSave.run.failedPrefix') + msg,
                this.i18n.translate('ui.CLOSE'),
                { duration: 10000, panelClass: ['snackbar-error'] },
            );
            // Leave the progress dialog open so the user can inspect failed
            // entries; switch isRunning off so the Cancel button hides and
            // Close shows.
            this.progress.setRunning(false);
        } finally {
            this.progress.setRunning(false);
        }
    }

    /**
     * Loads `injection_save_manifest.md` with the same profile-fallback chain
     * `InjectionService` uses: try active prompt profile first, fall back to
     * the default (built-in) profile, fall back to the language-folder root.
     */
    private async loadManifestPrompt(lang: string, profileId: string): Promise<string> {
        const langFolder = getLangFolder(lang);
        const candidates = [
            `${getProfileBasePath(langFolder, profileId)}/${MANIFEST_PROMPT_FILENAME}`,
        ];
        if (profileId !== DEFAULT_PROFILE_ID) {
            candidates.push(`${getProfileBasePath(langFolder, DEFAULT_PROFILE_ID)}/${MANIFEST_PROMPT_FILENAME}`);
        }
        candidates.push(`assets/system_files/${langFolder}/${MANIFEST_PROMPT_FILENAME}`);

        for (const path of candidates) {
            try {
                const response = await fetch(path, { cache: 'no-store' });
                if (response.ok) return await response.text();
            } catch { /* try next */ }
        }
        throw new Error(`Failed to load ${MANIFEST_PROMPT_FILENAME} (tried ${candidates.length} paths)`);
    }

    /**
     * Mirrors `ContextBuilder.augmentSingleCallHistory` but trimmed: no
     * protocol_single / correction-reminder hooks (manifest mode bypasses
     * the resolver/narrator protocol), and the intent tag is implicit
     * (SaveAgent is the only consumer of this history).
     */
    private appendUserMessage(history: LLMContent[], manifestPrompt: string, userInput: string): LLMContent[] {
        const merged = manifestPrompt.replace(/\{\{USER_INPUT\}\}/g, () => userInput);
        return [...history, { role: 'user', parts: [{ text: merged }] }];
    }
}
