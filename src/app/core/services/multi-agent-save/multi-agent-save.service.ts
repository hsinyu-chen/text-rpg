import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { LLMContent } from '@hcs/llm-core';
import { MatDialog } from '@angular/material/dialog';
import { ContextBuilderService } from '../context-builder.service';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { GameStateService } from '../game-state.service';
import { FileUpdateParser } from '../file-update-parser';
import type { FileUpdate } from '../file-update.service';
import { AutoUpdateDialogComponent } from '@app/shared/components/auto-update-dialog/auto-update-dialog.component';
import { SaveProgressDialogComponent } from '@app/features/multi-agent-save/save-progress-dialog.component';
import { SaveAgentRunnerService } from './save-agent-runner.service';
import { SubToolDispatcherService } from './sub-tool-dispatcher.service';
import { SaveProgressTracker } from './progress/save-progress-tracker.service';
import { getLocale, getLangFolder } from '@app/core/constants/locales';
import { DEFAULT_PROFILE_ID, getProfileBasePath } from '@app/core/constants/prompt-profiles';
import { FULLSCREEN_DIALOG_CONFIG } from '@app/shared/material/dialog-presets';
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
        // Re-entrancy guard. GameEngineService.sendMessage's status==='generating'
        // guard doesn't fire for multi-agent save (we bypass startTurn), so a
        // user double-clicking the save button would otherwise spawn two
        // concurrent runs sharing the same SaveProgressTracker.
        // Precondition guards (parallel to GameEngineService.startSession's
        // sanity checks): multi-agent save bypasses prepareCacheOrAbort so it
        // must self-validate. Empty KB → SaveAgent would still produce a
        // manifest and the dispatcher would silently do nothing. Run BEFORE
        // any state mutation (reset / setRunning) so an early-aborted run
        // doesn't clear a tracker entry the user is still inspecting from a
        // prior run.
        if (!this.state.isConfigured()) {
            this.snackBar.open(
                this.i18n.translate('multiAgentSave.run.notConfigured'),
                this.i18n.translate('ui.CLOSE'),
                { duration: 6000, panelClass: ['snackbar-warning'] },
            );
            return;
        }
        if (this.state.loadedFiles().size === 0) {
            this.snackBar.open(
                this.i18n.translate('multiAgentSave.run.noFiles'),
                this.i18n.translate('ui.CLOSE'),
                { duration: 6000, panelClass: ['snackbar-warning'] },
            );
            return;
        }

        if (this.progress.isRunning()) return;

        this.progress.reset();
        this.progress.setRunning(true);

        try {
            // Modal dialog + abort controller live inside the try so a
            // synchronous throw from `dialog.open()` doesn't strand the UI
            // lock — `finally` still runs setRunning(false).
            const abortController = new AbortController();
            const dialogRef = this.dialog.open(SaveProgressDialogComponent, {
                width: '780px',
                maxWidth: '95vw',
                maxHeight: '90vh',
                disableClose: true,
                panelClass: 'save-progress-dialog-panel',
            });
            dialogRef.componentInstance.attachAbort(abortController);

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
            const saveAgentResult = await this.saveAgent.run({
                provider,
                providerConfig: this.providerRegistry.getActiveConfig(),
                systemInstruction,
                cachedContentName: buildCtx.kbCacheName || undefined,
                history,
                signal: abortController.signal,
            });
            const { manifest, finishReason } = saveAgentResult;

            // SaveAgent finishing on anything other than `stop` typically means
            // truncation (max_tokens) — bestEffortJsonParser will still close
            // brackets to salvage a structurally-valid manifest, but it's
            // *incomplete*. Warn rather than letting the user think a partial
            // save was the whole story.
            if (finishReason && !isCleanFinish(finishReason)) {
                this.snackBar.open(
                    this.i18n.translate('multiAgentSave.run.finishWarning', { reason: finishReason }),
                    this.i18n.translate('ui.CLOSE'),
                    { duration: 8000, panelClass: ['snackbar-warning'] },
                );
            }

            // 4. Dispatcher — fans out to mechanical handlers (Phase 1: inventoryDeltas only).
            const dispatchResult = this.dispatcher.dispatch({
                manifest,
                coreFilenames: getLocale(lang).coreFilenames,
                kbFiles: this.state.loadedFiles(),
            });

            // 5. Parse → FileUpdate[]. Empty xml ≡ no work for any handler;
            //    the progress dialog already shows every section's outcome
            //    (empty_section / not_yet_implemented), so we just let it
            //    stay open with its Close button — no extra snackbar needed.
            if (!dispatchResult.xml) return;

            const updates = FileUpdateParser.parse(dispatchResult.xml);

            // 6. Hand off to AutoUpdateDialog. It applies internally via
            //    engine.updateSingleFile + saveCurrentSessionToBook (which
            //    bumps lastActiveAt itself) and closes with a boolean —
            //    there's no FileUpdate[] returned via afterClosed, so we
            //    don't post-process here. Close the progress dialog first
            //    so the user isn't looking at two stacked modals. AWAIT
            //    the close so the chat surface stays save-locked + the
            //    sendMessage re-entrancy guard stays armed while the user
            //    reviews / applies updates.
            dialogRef.close();
            await this.openAutoUpdateDialog(updates);
        } catch (err: unknown) {
            // User-initiated cancellation (Cancel button → AbortController.abort()).
            // Stream error names vary by provider — match the common ones rather
            // than the snackbar treating "I cancelled" as a scary failure.
            if (isAbortError(err)) {
                console.log('[MultiAgentSave] Run aborted by user.');
                // Leave the progress dialog open so the user sees which entries
                // completed before the abort.
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[MultiAgentSave] Run failed:', err);
            this.snackBar.open(
                this.i18n.translate('multiAgentSave.run.failedPrefix') + msg,
                this.i18n.translate('ui.CLOSE'),
                { duration: 10000, panelClass: ['snackbar-error'] },
            );
        } finally {
            // Single canonical reset site — `setRunning(false)` hides the
            // dialog's Cancel button + lets the chat mask lift, both on
            // success and on any thrown / aborted exit.
            this.progress.setRunning(false);
        }
    }

    /**
     * Loads `injection_save_manifest.md` with the same profile-fallback chain
     * `InjectionService` uses: try the active profile first, fall back to the
     * default (built-in cloud) profile. The cloud profile's `getProfileBasePath`
     * resolves to `assets/system_files/${lang}` (cloud has `subDir: null`),
     * so the language-root path is implicitly covered by the default-profile
     * fallback — no separate third candidate.
     */
    private async loadManifestPrompt(lang: string, profileId: string): Promise<string> {
        const langFolder = getLangFolder(lang);
        const activePath = `${getProfileBasePath(langFolder, profileId)}/${MANIFEST_PROMPT_FILENAME}`;
        const defaultPath = `${getProfileBasePath(langFolder, DEFAULT_PROFILE_ID)}/${MANIFEST_PROMPT_FILENAME}`;
        // Push the default-profile fallback only when its resolved path
        // differs — user profiles without a `subDir` resolve to the same
        // language-root path as the cloud default, so the second fetch
        // would be pure duplication.
        const candidates = [activePath];
        if (defaultPath !== activePath) candidates.push(defaultPath);

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

    /**
     * Hands the dispatcher's `FileUpdate[]` to AutoUpdateDialog. The dialog
     * runs its own apply pipeline (`engine.updateSingleFile` per group,
     * `saveCurrentSessionToBook` for timestamp bumps) and closes with a
     * boolean — no afterClosed-driven post-processing needed here.
     *
     * Returns the afterClosed promise so the orchestrator can keep the
     * save-locked surface up + the sendMessage re-entrancy guard armed
     * while the user reviews the diff.
     */
    private async openAutoUpdateDialog(updates: FileUpdate[]): Promise<void> {
        const ref = this.dialog.open(AutoUpdateDialogComponent, {
            data: { updates },
            ...FULLSCREEN_DIALOG_CONFIG,
        });
        await firstValueFrom(ref.afterClosed());
    }
}

/**
 * Standard DOMException name for `AbortController.abort()`-propagated errors.
 * Keep the check tight — matching the message string would swallow real
 * provider errors that happen to contain "aborted" (e.g. "request aborted
 * by upstream proxy", "session abort: invalid token").
 */
function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
}

/**
 * Provider finishReason values that we consider "clean completion" — anything
 * else (max_tokens, safety, recitation, length, …) means the manifest may be
 * truncated even when bestEffortJsonParser closed the brackets.
 */
function isCleanFinish(finishReason: string): boolean {
    const normalized = finishReason.toLowerCase();
    // 'null' covers providers that stringify a literal null finishReason.
    return normalized === 'stop' || normalized === 'null' || normalized === '';
}
