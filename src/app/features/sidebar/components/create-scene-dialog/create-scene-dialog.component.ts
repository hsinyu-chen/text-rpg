import { Component, ChangeDetectionStrategy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDividerModule } from '@angular/material/divider';
import type { LLMContent } from '@hcs/llm-core';

import { GameStateService } from '../../../../core/services/game-state.service';
import { SessionService } from '../../../../core/services/session.service';
import { LLMProviderRegistryService } from '../../../../core/services/llm-provider-registry.service';
import { LOCALES, getLocale } from '../../../../core/constants/locales';
import { MonacoEditorComponent } from '../../../../shared/components/monaco-editor/monaco-editor.component';

type Phase = 'input' | 'processing' | 'review';
type ProcessingStage = 'opening' | 'extracting' | 'done';
type FileStatus = 'pending' | 'processing' | 'done' | 'skipped' | 'failed';

interface FileState {
    status: FileStatus;
    notes?: string;
}

/** Map coreFilenames key → per-file prompt filename (relative to the locale folder). */
const PROMPT_FILE_MAP: Record<string, string> = {
    BASIC_SETTINGS: 'create_scene_basic_settings.md',
    STORY_OUTLINE: 'create_scene_story_outline.md',
    CHARACTER_STATUS: 'create_scene_character_status.md',
    ASSETS: 'create_scene_assets.md',
    TECH_EQUIPMENT: 'create_scene_tech_equipment.md',
    WORLD_FACTIONS: 'create_scene_world_factions.md',
    MAGIC: 'create_scene_magic.md',
    PLANS: 'create_scene_plans.md',
    INVENTORY: 'create_scene_inventory.md'
};

const OPENING_SCHEMA = {
    type: 'object',
    properties: {
        scene_opening: { type: 'string' }
    },
    required: ['scene_opening']
};

const EXTRACTION_SCHEMA = {
    type: 'object',
    properties: {
        notes: { type: 'string' },
        content: { type: 'string' }
    },
    required: ['notes', 'content']
};

@Component({
    selector: 'app-create-scene-dialog',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatDialogModule,
        MatButtonModule,
        MatIconModule,
        MatFormFieldModule,
        MatInputModule,
        MatSelectModule,
        MatProgressBarModule,
        MatProgressSpinnerModule,
        MatSnackBarModule,
        MatTooltipModule,
        MatCheckboxModule,
        MatDividerModule,
        MonacoEditorComponent
    ],
    templateUrl: './create-scene-dialog.component.html',
    styleUrl: './create-scene-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class CreateSceneDialogComponent {
    private dialogRef = inject(MatDialogRef<CreateSceneDialogComponent>);
    private http = inject(HttpClient);
    private state = inject(GameStateService);
    private session = inject(SessionService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private snackBar = inject(MatSnackBar);

    phase = signal<Phase>('input');
    stage = signal<ProcessingStage>('opening');

    // Inputs
    location = signal('');
    character = signal('');
    startScene = signal('');

    // File selection
    selectableFiles = signal<string[]>([]);
    copyVerbatim = signal<Map<string, boolean>>(new Map());
    selectedCount = computed(() => {
        let n = 0;
        for (const v of this.copyVerbatim().values()) if (v) n++;
        return n;
    });

    // Processing state
    expandedOpening = signal('');
    totalFiles = signal(0);
    processedFiles = signal(0);
    currentFile = signal('');
    processingError = signal<string | null>(null);

    // Per-file processing state (order preserved via fileOrder).
    fileOrder = signal<string[]>([]);
    fileStates = signal<Map<string, FileState>>(new Map());

    // Prompt Processing (PP / prefill) progress for the current LLM call.
    ppProgress = signal(0);
    ppProcessed = signal(0);
    ppTotal = signal(0);
    ppPercent = computed(() => Math.round(this.ppProgress() * 100));
    ppActive = computed(() => this.ppTotal() > 0 && this.ppProgress() < 1);

    // Per-file extracted content (excluding copy-verbatim; patched with last_scene on story outline).
    generatedFiles = signal<Map<string, string>>(new Map());

    progressFraction = computed(() => {
        const total = this.totalFiles();
        if (total === 0) return 0;
        return this.processedFiles() / total;
    });
    progressPercent = computed(() => Math.round(this.progressFraction() * 100));
    remainingFiles = computed(() => Math.max(0, this.totalFiles() - this.processedFiles()));

    // Review state — diff mode shares one file picker for original vs generated.
    reviewFiles = computed(() => Array.from(this.generatedFiles().keys()).sort());
    activeReviewFile = signal('');
    reviewOriginal = computed(() => this.state.loadedFiles().get(this.activeReviewFile()) ?? '');
    reviewModified = computed(() => this.generatedFiles().get(this.activeReviewFile()) ?? '');

    isCreatingBook = signal(false);

    private abortController: AbortController | null = null;

    constructor() {
        const defaultCheckedNames = new Set<string>([
            ...Object.values(LOCALES).map(l => l.coreFilenames.BASIC_SETTINGS),
            ...Object.values(LOCALES).map(l => l.coreFilenames.ASSETS),
            ...Object.values(LOCALES).map(l => l.coreFilenames.INVENTORY),
            ...Object.values(LOCALES).map(l => l.coreFilenames.MAGIC)
        ]);

        const files: string[] = [];
        const checks = new Map<string, boolean>();
        for (const name of this.state.loadedFiles().keys()) {
            if (name.startsWith('system_files/') || name === 'system_prompt.md') continue;
            files.push(name);
            checks.set(name, defaultCheckedNames.has(name));
        }
        files.sort();
        this.selectableFiles.set(files);
        this.copyVerbatim.set(checks);
    }

    isChecked(name: string): boolean {
        return !!this.copyVerbatim().get(name);
    }

    toggleFile(name: string, checked: boolean) {
        this.copyVerbatim.update(m => {
            const next = new Map(m);
            next.set(name, checked);
            return next;
        });
    }

    isInputValid(): boolean {
        return !!(this.location().trim() && this.character().trim() && this.startScene().trim());
    }

    async start() {
        if (!this.isInputValid()) return;
        if (!this.providerRegistry.getActive()) {
            this.snackBar.open('No active LLM provider. Configure an API key first.', 'Close', { duration: 5000 });
            return;
        }
        if (this.state.loadedFiles().size === 0) {
            this.snackBar.open('No Knowledge Base loaded.', 'Close', { duration: 5000 });
            return;
        }

        this.phase.set('processing');
        this.stage.set('opening');
        this.processingError.set(null);
        this.expandedOpening.set('');
        this.generatedFiles.set(new Map());
        this.processedFiles.set(0);
        this.currentFile.set('');
        this.totalFiles.set(0);
        this.fileOrder.set([]);
        this.fileStates.set(new Map());
        this.abortController = new AbortController();

        try {
            await this.runLoop();
            this.prepareReview();
            this.phase.set('review');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === 'Aborted' || (e instanceof Error && e.name === 'AbortError')) {
                this.phase.set('input');
                this.snackBar.open('Scene creation aborted.', 'Close', { duration: 3000 });
            } else {
                console.error('[CreateScene] Failed:', e);
                this.processingError.set(msg);
                this.snackBar.open(`Scene creation failed: ${msg}`, 'Close', { duration: 6000 });
            }
        } finally {
            this.abortController = null;
        }
    }

    abort() {
        this.abortController?.abort();
    }

    private resetPp() {
        this.ppProgress.set(0);
        this.ppProcessed.set(0);
        this.ppTotal.set(0);
    }

    private trackPp(usage: unknown) {
        if (!usage || typeof usage !== 'object') return;
        const u = usage as { promptProgress?: number; promptProcessed?: number; promptTotal?: number };
        if (typeof u.promptProgress === 'number') this.ppProgress.set(u.promptProgress);
        if (typeof u.promptProcessed === 'number') this.ppProcessed.set(u.promptProcessed);
        if (typeof u.promptTotal === 'number') this.ppTotal.set(u.promptTotal);
    }

    /** Returns the coreFilenames key (e.g. 'STORY_OUTLINE') whose locale value matches this filename, or null. */
    private findPromptKeyForFile(filename: string): string | null {
        for (const locale of Object.values(LOCALES)) {
            for (const [key, val] of Object.entries(locale.coreFilenames)) {
                if (val === filename) return key;
            }
        }
        return null;
    }

    private setFileState(name: string, patch: Partial<FileState>) {
        this.fileStates.update(m => {
            const next = new Map(m);
            const prev = next.get(name) ?? { status: 'pending' as FileStatus };
            next.set(name, { ...prev, ...patch });
            return next;
        });
    }

    fileStatusFor(name: string): FileStatus {
        return this.fileStates().get(name)?.status ?? 'pending';
    }

    fileNotesFor(name: string): string {
        return this.fileStates().get(name)?.notes ?? '';
    }

    private async runLoop() {
        const lang = this.state.config()?.outputLanguage || 'default';
        const locale = getLocale(lang);

        // Split files by verbatim vs. to-extract.
        const allFiles = this.state.loadedFiles();
        const checks = this.copyVerbatim();
        const copiedFiles: [string, string][] = [];
        const filesToProcess: [string, string][] = [];
        for (const name of this.selectableFiles()) {
            const content = allFiles.get(name);
            if (content === undefined) continue;
            if (checks.get(name)) copiedFiles.push([name, content]);
            else filesToProcess.push([name, content]);
        }

        // Context prefix used by the per-file extract stage: only the user-chosen verbatim files.
        const contextPrefix = copiedFiles
            .map(([name, content]) => `### ${name}\n\n${content}`)
            .join('\n\n---\n\n');

        // Context prefix used by the opening-scene stage: ALL KB files (verbatim + to-process),
        // but with any `# last_scene` block stripped from Story Outline files so the opening writer
        // is not biased by the previous session's last scene.
        const storyOutlineNames = new Set(Object.values(LOCALES).map(l => l.coreFilenames.STORY_OUTLINE));
        const openingContextPrefix = [...copiedFiles, ...filesToProcess]
            .map(([name, content]) => {
                const clean = storyOutlineNames.has(name) ? this.stripLastScene(content) : content;
                return `### ${name}\n\n${clean}`;
            })
            .join('\n\n---\n\n');

        // === Stage 1: Expand the opening scene ===
        this.stage.set('opening');
        const openingTemplate = await firstValueFrom(
            this.http.get(`assets/system_files/${locale.folder}/create_scene_opening.md`, { responseType: 'text' })
        );
        const openingSystemInstruction = openingTemplate
            .replace(/\{\{LOCATION\}\}/g, this.location().trim())
            .replace(/\{\{CHARACTER\}\}/g, this.character().trim())
            .replace(/\{\{START_SCENE\}\}/g, this.startScene().trim());

        const expanded = await this.callOpening(openingSystemInstruction, openingContextPrefix);
        this.expandedOpening.set(expanded);

        if (this.abortController?.signal.aborted) throw new Error('Aborted');

        // === Stage 2: Per-file extraction ===
        this.stage.set('extracting');
        const extractBaseTemplate = await firstValueFrom(
            this.http.get(`assets/system_files/${locale.folder}/create_scene.md`, { responseType: 'text' })
        );

        // Per-file prompt cache to avoid re-fetching on every call.
        const perFileCache = new Map<string, string>();
        const getPerFileGuidance = async (sourceFileName: string): Promise<string> => {
            const key = this.findPromptKeyForFile(sourceFileName);
            if (!key || !PROMPT_FILE_MAP[key]) {
                return `### Current file: ${sourceFileName}\n\n(No file-specific guidance available. Apply the universal rules above.)`;
            }
            const cached = perFileCache.get(key);
            if (cached !== undefined) return cached;
            const loaded = await firstValueFrom(
                this.http.get(`assets/system_files/${locale.folder}/${PROMPT_FILE_MAP[key]}`, { responseType: 'text' })
            );
            perFileCache.set(key, loaded);
            return loaded;
        };

        const buildExtractSystemInstruction = async (sourceFileName: string): Promise<string> => {
            const guidance = await getPerFileGuidance(sourceFileName);
            const combined = extractBaseTemplate.replace(/\{\{FILE_SPECIFIC_GUIDANCE\}\}/g, guidance);
            return combined
                .replace(/\{\{LOCATION\}\}/g, this.location().trim())
                .replace(/\{\{CHARACTER\}\}/g, this.character().trim())
                .replace(/\{\{EXPANDED_OPENING\}\}/g, expanded);
        };

        this.totalFiles.set(filesToProcess.length);
        this.fileOrder.set(filesToProcess.map(([n]) => n));
        const initialStates = new Map<string, FileState>();
        for (const [name] of filesToProcess) initialStates.set(name, { status: 'pending' });
        this.fileStates.set(initialStates);

        // Start with verbatim-copied files in the output.
        const working = new Map<string, string>();
        for (const [name, content] of copiedFiles) working.set(name, content);
        this.generatedFiles.set(new Map(working));

        for (let i = 0; i < filesToProcess.length; i++) {
            if (this.abortController?.signal.aborted) throw new Error('Aborted');

            const [name, content] = filesToProcess[i];
            this.currentFile.set(name);
            this.processedFiles.set(i);
            this.setFileState(name, { status: 'processing' });

            try {
                const systemInstruction = await buildExtractSystemInstruction(name);
                const result = await this.extractFromFile(systemInstruction, contextPrefix, name, content);

                const body = (result.content || '').trim();
                if (body) {
                    working.set(name, body);
                    this.generatedFiles.set(new Map(working));
                    this.setFileState(name, { status: 'done', notes: result.notes });
                } else {
                    this.setFileState(name, { status: 'skipped', notes: result.notes || '(no relevant content)' });
                }
            } catch (e) {
                if (this.abortController?.signal.aborted) throw e;
                const msg = e instanceof Error ? e.message : String(e);
                this.setFileState(name, { status: 'failed', notes: msg });
                throw e;
            }
        }

        this.processedFiles.set(filesToProcess.length);
        this.currentFile.set('');

        // === Stage 3: Patch Story Outline with last_scene ===
        // Force Story Outline to exist so startSession can extract the opening.
        const outlineName = this.findStoryOutlineName(working, locale);
        const existingOutline = working.get(outlineName) ?? '';
        const patched = this.appendLastScene(existingOutline, expanded);
        working.set(outlineName, patched);

        this.generatedFiles.set(new Map(working));
        this.stage.set('done');
    }

    /**
     * Resolve the story-outline filename to use in the output.
     * Prefers an already-extracted outline (any locale variant), falls back to the current locale's default.
     */
    private findStoryOutlineName(working: Map<string, string>, locale: ReturnType<typeof getLocale>): string {
        const variants = new Set(Object.values(LOCALES).map(l => l.coreFilenames.STORY_OUTLINE));
        for (const name of working.keys()) {
            if (variants.has(name)) return name;
        }
        return locale.coreFilenames.STORY_OUTLINE;
    }

    private stripLastScene(content: string): string {
        return content.replace(/(?:^|\n)#\s*last[_-]?scene[\s\S]*$/i, '').trimEnd();
    }

    private appendLastScene(existing: string, opening: string): string {
        const stripped = this.stripLastScene(existing);
        const base = stripped ? stripped + '\n\n' : '';
        return `${base}# last_scene\n${opening}\n`;
    }

    private async callOpening(systemInstruction: string, contextPrefix: string): Promise<string> {
        const provider = this.providerRegistry.getActive();
        if (!provider) throw new Error('No active LLM provider');
        const config = this.providerRegistry.getActiveConfig();

        const parts: { text: string }[] = [];
        if (contextPrefix) {
            parts.push({
                text: `[Fixed base settings — authoritative background; reference only]\n\n${contextPrefix}`
            });
        }
        const contents: LLMContent[] = [{ role: 'user', parts: parts.length ? parts : [{ text: '(no base settings provided)' }] }];

        this.resetPp();
        const stream = provider.generateContentStream(
            config,
            contents,
            systemInstruction,
            {
                responseMimeType: 'application/json',
                responseSchema: OPENING_SCHEMA,
                signal: this.abortController?.signal,
                intent: 'CREATE_SCENE_OPENING'
            }
        );

        let full = '';
        for await (const chunk of stream) {
            this.trackPp(chunk.usageMetadata);
            if (chunk.text && !chunk.thought) full += chunk.text;
        }

        try {
            const parsed = JSON.parse(full) as { scene_opening?: unknown };
            if (typeof parsed.scene_opening === 'string' && parsed.scene_opening.trim()) {
                return parsed.scene_opening.trim();
            }
        } catch (e) {
            console.warn('[CreateScene] Failed to parse opening JSON, falling back to raw input:', full, e);
        }
        // Fallback: use the user's raw opening so the flow can proceed.
        return this.startScene().trim();
    }

    private async extractFromFile(
        systemInstruction: string,
        contextPrefix: string,
        currentFileName: string,
        currentFileContent: string
    ): Promise<{ notes: string; content: string }> {
        const provider = this.providerRegistry.getActive();
        if (!provider) throw new Error('No active LLM provider');
        const config = this.providerRegistry.getActiveConfig();

        const parts: { text: string }[] = [];
        if (contextPrefix) {
            parts.push({
                text: `[Fixed base settings — reference only; do NOT re-extract]\n\n${contextPrefix}`
            });
        }
        parts.push({
            text: `[Currently analyzing source file: ${currentFileName}]\n\n${currentFileContent}`
        });

        const contents: LLMContent[] = [{ role: 'user', parts }];

        this.resetPp();
        const stream = provider.generateContentStream(
            config,
            contents,
            systemInstruction,
            {
                responseMimeType: 'application/json',
                responseSchema: EXTRACTION_SCHEMA,
                signal: this.abortController?.signal,
                intent: 'CREATE_SCENE'
            }
        );

        let full = '';
        for await (const chunk of stream) {
            this.trackPp(chunk.usageMetadata);
            if (chunk.text && !chunk.thought) full += chunk.text;
        }

        try {
            const parsed = JSON.parse(full) as { notes?: unknown; content?: unknown };
            return {
                notes: typeof parsed.notes === 'string' ? parsed.notes : '',
                content: typeof parsed.content === 'string' ? parsed.content : ''
            };
        } catch (e) {
            console.warn('[CreateScene] Failed to parse JSON for file', currentFileName, full, e);
            return { notes: '(parse failed — file skipped)', content: '' };
        }
    }

    private prepareReview() {
        const files = this.reviewFiles();
        if (files.length === 0) {
            this.activeReviewFile.set('');
            return;
        }

        // Prefer the story outline (the one with last_scene) as the initial view.
        const storyOutlineNames = new Set(Object.values(LOCALES).map(l => l.coreFilenames.STORY_OUTLINE));
        const preferred = files.find(f => storyOutlineNames.has(f));
        this.activeReviewFile.set(preferred ?? files[0]);
    }

    onModifiedChange(newValue: string) {
        const name = this.activeReviewFile();
        if (!name) return;
        this.generatedFiles.update(m => {
            const next = new Map(m);
            next.set(name, newValue);
            return next;
        });
    }

    async confirm() {
        this.isCreatingBook.set(true);
        try {
            const bookName = `Scene: ${this.location().trim()}`.substring(0, 80);
            await this.session.createSceneBook(bookName, this.generatedFiles());
            this.snackBar.open(`Created new Book "${bookName}".`, 'OK', { duration: 3000 });
            this.dialogRef.close(true);
        } catch (e) {
            console.error('[CreateScene] Failed to create book', e);
            const msg = e instanceof Error ? e.message : String(e);
            this.snackBar.open(`Failed to create book: ${msg}`, 'Close', { duration: 5000 });
        } finally {
            this.isCreatingBook.set(false);
        }
    }

    backToInput() {
        this.abortController?.abort();
        this.abortController = null;
        this.processingError.set(null);
        this.phase.set('input');
    }

    cancel() {
        this.abortController?.abort();
        this.dialogRef.close();
    }
}
