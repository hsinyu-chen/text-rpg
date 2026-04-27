import {
    Component,
    ElementRef,
    OnDestroy,
    viewChild,
    afterNextRender,
    inject,
    input,
    output,
    effect,
    signal,
    forwardRef
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { MonacoLoaderService } from '../../../core/services/monaco-loader.service';

const DEFAULT_OPTIONS = {
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    wordWrap: 'on'
};

const DEFAULT_DIFF_OPTIONS = {
    ...DEFAULT_OPTIONS,
    readOnly: true,
    renderSideBySide: true
};

@Component({
    selector: 'app-monaco-editor',
    standalone: true,
    templateUrl: './monaco-editor.component.html',
    styleUrl: './monaco-editor.component.scss',
    providers: [
        {
            provide: NG_VALUE_ACCESSOR,
            useExisting: forwardRef(() => MonacoEditorComponent),
            multi: true
        }
    ]
})
export class MonacoEditorComponent implements OnDestroy, ControlValueAccessor {
    private loader = inject(MonacoLoaderService);
    private container = viewChild<ElementRef>('container');

    // Inputs using modern Signal-based syntax
    options = input<unknown>({});
    language = input<string>('markdown');
    isDiff = input<boolean>(false);
    originalValue = input<string>(''); // For diff mode
    theme = input<string>('vs-dark');

    // Multi-model mode inputs
    multiModelMode = input<boolean>(false);
    files = input<Map<string, string>>(new Map());
    activeFile = input<string>('');
    /**
     * When set together with multiModelMode=true, the editor renders as a
     * multi-file diff: each file's `originalFiles` snapshot on the left,
     * the live `files` content on the right. Switching activeFile swaps
     * both models in tandem. Default null = normal multi-model behavior.
     * Toggling between null and a Map should be done by re-rendering the
     * component (e.g. an @if in the host template) rather than swapping
     * this input on a live editor.
     */
    originalFiles = input<Map<string, string> | null>(null);

    // Outputs
    initialized = output<import('monaco-editor').editor.IStandaloneCodeEditor | import('monaco-editor').editor.IStandaloneDiffEditor>();
    valueChange = output<string>();
    activeFileChange = output<string>();
    /** Emitted when text is selected in the ORIGINAL editor (left pane in diff mode) */
    selectionChange = output<{ text: string, startLineNumber: number, endLineNumber: number } | null>();

    private editor: import('monaco-editor').editor.IStandaloneCodeEditor | import('monaco-editor').editor.IStandaloneDiffEditor | null = null;
    private resizeObserver?: ResizeObserver;
    private isInitialized = signal(false);

    // Multi-model storage: filename -> ITextModel (the "modified" / current side)
    private multiModelMap = new Map<string, import('monaco-editor').editor.ITextModel>();
    // Snapshot models when in multi-file diff mode (the "original" side, frozen)
    private originalModelMap = new Map<string, import('monaco-editor').editor.ITextModel>();
    private contentChangeDisposable: import('monaco-editor').IDisposable | null = null;
    private disposables: import('monaco-editor').IDisposable[] = [];

    /** True when the editor was constructed as a diff editor (single-file or multi-file). */
    private get isAnyDiff(): boolean {
        return this.isDiff() || (this.multiModelMode() && !!this.originalFiles());
    }
    /** True when running in multi-file diff mode (multiModelMode + originalFiles). */
    private get isMultiDiff(): boolean {
        return this.multiModelMode() && !!this.originalFiles();
    }

    // ControlValueAccessor state
    private _value = '';
    private _onChange: (value: string) => void = () => { /* empty */ };
    private _onTouched: () => void = () => { /* empty */ };

    constructor() {
        // We use afterNextRender for Monaco initialization (Zoneless friendly)
        afterNextRender(async () => {
            await this.loader.load();
            this.initEditor();
        });

        // React to changes in inputs (Zoneless friendly via effects)
        effect(() => {
            if (!this.isInitialized() || !this.editor) return;

            const currentOptions = this.options() as import('monaco-editor').editor.IEditorOptions;
            const currentTheme = this.theme();

            // If isDiff changed, we need to re-init (rare, but possible)
            // For now, let's just update options
            this.editor.updateOptions({ ...currentOptions });
            window.monaco.editor.setTheme(currentTheme);
        });

        effect(() => {
            if (!this.isInitialized() || !this.editor) return;
            const currentLanguage = this.language();

            // Skip in any diff mode — single-file diff manages language via
            // updateDiffModels, multi-file diff sets per-file language at
            // model creation time. Casting a diff editor to code-editor here
            // would call setModelLanguage on an IDiffEditorModel object,
            // crashing because that object has no setLanguage method.
            if (this.isAnyDiff) return;
            const model = (this.editor as import('monaco-editor').editor.IStandaloneCodeEditor).getModel();
            if (model) {
                window.monaco.editor.setModelLanguage(model, currentLanguage);
            }
        });

        effect(() => {
            // Single-file diff mode only — multi-file diff drives both models
            // through switchToFile(activeFile) instead.
            if (!this.isInitialized() || !this.editor) return;
            if (!this.isDiff() || this.isMultiDiff) return;
            const original = this.originalValue();
            const modified = this._value;

            this.updateDiffModels(original, modified);
        });

        // Effect for multi-model mode (normal or diff): switch active file
        effect(() => {
            if (!this.isInitialized() || !this.editor || !this.multiModelMode()) return;
            const fileName = this.activeFile();
            if (!fileName) return;

            this.switchToFile(fileName);
        });
    }

    private initEditor() {
        const el = this.container()?.nativeElement;
        if (!el) return;

        const monaco = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
        const userOptions = (this.options() as object) || {};

        let commonOptions = {};
        if (this.isAnyDiff) {
            commonOptions = { ...DEFAULT_DIFF_OPTIONS, automaticLayout: true, ...userOptions };
        } else {
            commonOptions = { ...DEFAULT_OPTIONS, ...userOptions };
        }

        // Language and Theme overrides
        const finalOptions = {
            ...commonOptions,
            theme: this.theme() || (commonOptions as { theme?: string }).theme,
            language: this.language() || (commonOptions as { language?: string }).language,
            automaticLayout: false // Force false: we use explicit layout via ResizeObserver
        };

        if (this.isAnyDiff) {
            this.editor = monaco.editor.createDiffEditor(el, finalOptions as import('monaco-editor').editor.IDiffEditorConstructionOptions);

            if (this.isMultiDiff) {
                // Multi-file diff: pre-create both modified and original models per file,
                // then setModel({original, modified}) for the active one.
                const modifiedFiles = this.files();
                const originalSnapshot = this.originalFiles()!;
                modifiedFiles.forEach((content, fileName) => {
                    this.multiModelMap.set(fileName, this.createModel(fileName, content, 'modified'));
                });
                originalSnapshot.forEach((content, fileName) => {
                    this.originalModelMap.set(fileName, this.createModel(fileName, content, 'original'));
                });
                const activeFileName = this.activeFile();
                if (activeFileName) {
                    this.switchToFile(activeFileName);
                }
                // Force a layout call after setting models
                this.editor?.layout();
            } else {
                this.updateDiffModels(this.originalValue(), this._value);
            }

            // Listen for changes in the modified model. Re-bind on every model
            // swap so multi-file diff also fires valueChange after a switch.
            const bindModifiedListener = () => {
                const modifiedModel = (this.editor as import('monaco-editor').editor.IStandaloneDiffEditor).getModel()?.modified;
                if (this.contentChangeDisposable) {
                    this.contentChangeDisposable.dispose();
                    this.contentChangeDisposable = null;
                }
                if (modifiedModel) {
                    this.contentChangeDisposable = modifiedModel.onDidChangeContent(() => {
                        const value = modifiedModel.getValue();
                        this._value = value;
                        this._onChange(value);
                        this.valueChange.emit(value);
                    });
                }
            };
            bindModifiedListener();
            this.disposables.push(
                (this.editor as import('monaco-editor').editor.IStandaloneDiffEditor)
                    .onDidChangeModel(() => bindModifiedListener())
            );

            // [NEW] Listen for selection changes in the ORIGINAL editor (left pane)
            const originalEditor = (this.editor as import('monaco-editor').editor.IStandaloneDiffEditor).getOriginalEditor();

            const handleSelectionFinished = () => {
                const selection = originalEditor.getSelection();
                const model = originalEditor.getModel();
                if (selection && model && !selection.isEmpty()) {
                    const text = model.getValueInRange(selection);
                    this.selectionChange.emit({
                        text,
                        startLineNumber: selection.startLineNumber,
                        endLineNumber: selection.endLineNumber
                    });
                } else {
                    this.selectionChange.emit(null);
                }
            };

            this.disposables.push(originalEditor.onMouseUp(() => handleSelectionFinished()));
            this.disposables.push(originalEditor.onKeyUp(() => handleSelectionFinished()));
        } else {
            this.editor = monaco.editor.create(el, {
                ...finalOptions,
                value: this._value
            } as import('monaco-editor').editor.IStandaloneEditorConstructionOptions);

            // Multi-model mode: create all models upfront
            if (this.multiModelMode()) {
                const filesMap = this.files();
                filesMap.forEach((content, fileName) => {
                    this.multiModelMap.set(fileName, this.createModel(fileName, content, 'normal'));
                });

                // Switch to active file if provided
                const activeFileName = this.activeFile();
                if (activeFileName) {
                    this.switchToFile(activeFileName);
                }
            }

            (this.editor as import('monaco-editor').editor.IStandaloneCodeEditor).onDidChangeModelContent(() => {
                const value = (this.editor as import('monaco-editor').editor.IStandaloneCodeEditor).getValue();
                this._value = value;
                this._onChange(value);
                this.valueChange.emit(value);
            });

            (this.editor as import('monaco-editor').editor.IStandaloneCodeEditor).onDidBlurEditorText(() => {
                this._onTouched();
            });
        }

        // Always use our ResizeObserver with explicit dimensions to prevent DiffEditor collapse
        this.resizeObserver = new ResizeObserver((entries) => {
            if (this.editor && entries.length > 0) {
                const { width, height } = entries[0].contentRect;
                if (width > 0 && height > 0) {
                    this.editor.layout({ width, height });
                }
            }
        });
        this.resizeObserver.observe(el);

        this.isInitialized.set(true);
        if (this.editor) {
            this.initialized.emit(this.editor);
        }
    }

    private updateDiffModels(original: string, modified: string) {
        if (!this.editor || !this.isDiff()) return;

        const monaco = window.monaco;
        const diffEditor = this.editor as import('monaco-editor').editor.IStandaloneDiffEditor;
        const oldModels = diffEditor.getModel();
        const lang = this.language();

        // Optimization: If models already exist with correct language, just update values
        // This prevents 'no diff result available' race conditions in the worker
        if (oldModels && oldModels.original.getLanguageId() === lang && oldModels.modified.getLanguageId() === lang) {
            if (oldModels.original.getValue() !== original) {
                oldModels.original.setValue(original);
            }
            if (oldModels.modified.getValue() !== modified) {
                oldModels.modified.setValue(modified);
            }
            return;
        }

        const originalModel = monaco.editor.createModel(original, lang);
        const modifiedModel = monaco.editor.createModel(modified, lang);

        diffEditor.setModel({
            original: originalModel,
            modified: modifiedModel
        });

        // Dispose old models to prevent leaks
        if (oldModels) {
            oldModels.original.dispose();
            oldModels.modified.dispose();
        }
    }

    // Support direct model setting (for multi-model support if needed)
    setModel(model: import('monaco-editor').editor.IDiffEditorModel | import('monaco-editor').editor.ITextModel) {
        if (this.editor) {
            if (this.isAnyDiff) {
                (this.editor as import('monaco-editor').editor.IStandaloneDiffEditor).setModel(model as import('monaco-editor').editor.IDiffEditorModel);
            } else {
                (this.editor as import('monaco-editor').editor.IStandaloneCodeEditor).setModel(model as import('monaco-editor').editor.ITextModel);
            }
        }
    }

    getEditor() {
        return this.editor;
    }

    /** Switch Monaco editor to display a specific file from the multiModelMap */
    switchToFile(fileName: string): void {
        if (!this.editor) return;

        if (this.isMultiDiff) {
            // Multi-file diff: swap both sides in tandem.
            const original = this.originalModelMap.get(fileName);
            const modified = this.multiModelMap.get(fileName);
            if (!original || !modified) {
                console.warn(`[MonacoEditor] Diff model pair not found for file: ${fileName}`);
                return;
            }
            const diffEditor = this.editor as import('monaco-editor').editor.IStandaloneDiffEditor;
            const current = diffEditor.getModel();
            if (current?.original === original && current?.modified === modified) return;
            diffEditor.setModel({ original, modified });
            this._value = modified.getValue();


            return;
        }

        if (this.isDiff()) return; // single-file diff has no per-file switching

        const model = this.multiModelMap.get(fileName);
        if (!model) {
            console.warn(`[MonacoEditor] Model not found for file: ${fileName}`);
            return;
        }

        const codeEditor = this.editor as import('monaco-editor').editor.IStandaloneCodeEditor;
        const currentModel = codeEditor.getModel();

        // Only switch if it's a different model
        if (currentModel !== model) {
            codeEditor.setModel(model);
            this._value = model.getValue();

        }
    }

    /** Create a Monaco model with a side-aware URI to keep diff originals/modifieds distinct. */
    private createModel(
        fileName: string,
        content: string,
        side: 'normal' | 'modified' | 'original'
    ): import('monaco-editor').editor.ITextModel {
        const monaco = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
        const lang = this.getLanguageFromFilename(fileName);
        const safeName = fileName.replace(/\\/g, '/');
        const uri = side === 'normal'
            ? monaco.Uri.parse(`file:///${safeName.startsWith('/') ? safeName.substring(1) : safeName}`)
            : monaco.Uri.parse(`file:///${side}/${safeName.startsWith('/') ? safeName.substring(1) : safeName}`);
        return monaco.editor.createModel(content, lang, uri);
    }

    /** Get language ID from filename extension */
    private getLanguageFromFilename(fileName: string): string {
        // Special case for postprocess script
        if (fileName === 'postprocess') return 'javascript';

        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const langMap: Record<string, string> = {
            'md': 'markdown',
            'json': 'json',
            'js': 'javascript',
            'ts': 'typescript',
            'html': 'html',
            'css': 'css',
            'scss': 'scss',
            'txt': 'plaintext'
        };
        return langMap[ext] || 'markdown';
    }

    /** Get current value of a specific file model */
    getFileContent(fileName: string): string | undefined {
        return this.multiModelMap.get(fileName)?.getValue();
    }

    /** Update content of a specific file model (for replace functionality) */
    updateFileContent(fileName: string, newContent: string): void {
        let model = this.multiModelMap.get(fileName);
        if (!model && this.editor && this.multiModelMode()) {
            // Lazy-create: agent may write to a file the user has not yet
            // selected. In multi-diff mode, we need BOTH modified and original models.
            model = this.createModel(fileName, newContent, this.isMultiDiff ? 'modified' : 'normal');
            this.multiModelMap.set(fileName, model);

            if (this.isMultiDiff) {
                // For new files, original is empty string
                const originalModel = this.createModel(fileName, '', 'original');
                this.originalModelMap.set(fileName, originalModel);
            }
            return;
        }
        if (model) {
            model.setValue(newContent);
        }
    }

    /** Update content of the original (baseline) model for diff mode */
    updateOriginalFileContent(fileName: string, newContent: string): void {
        const model = this.originalModelMap.get(fileName);
        if (model) {
            model.setValue(newContent);
        }
    }

    /** Get all file names in multi-model mode */
    getFileNames(): string[] {
        return Array.from(this.multiModelMap.keys());
    }

    /**
     * Scroll the editor to reveal a specific line number (1-indexed).
     * Optionally positions cursor at a specific column.
     * Works for both regular and diff editors.
     */
    revealLine(lineNumber: number, column = 1): void {
        if (!this.editor) return;

        const targetEditor = this.isAnyDiff
            ? (this.editor as import('monaco-editor').editor.IStandaloneDiffEditor).getModifiedEditor()
            : (this.editor as import('monaco-editor').editor.IStandaloneCodeEditor);

        const model = targetEditor.getModel();
        if (!model) return;

        // Safety Guard: Ensure line number is within valid range of the current model
        const lineCount = model.getLineCount();
        if (lineNumber < 1 || lineNumber > lineCount) {
            console.warn(`[MonacoEditor] revealLine requested out-of-range line ${lineNumber} (Total lines: ${lineCount}). Ignoring to prevent crash.`);
            return;
        }

        targetEditor.revealLineInCenter(lineNumber);
        targetEditor.setPosition({ lineNumber, column });
    }

    ngOnDestroy() {
        // Dispose listeners FIRST so no event fires mid-teardown.
        if (this.contentChangeDisposable) {
            this.contentChangeDisposable.dispose();
            this.contentChangeDisposable = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];

        // Snapshot the models we want to dispose, then dispose the editor
        // BEFORE disposing the models. Monaco's DiffEditorWidget keeps
        // references to its current original/modified models and throws
        // "TextModel got disposed before DiffEditorWidget model got reset"
        // if the models go away while the widget still holds them.
        const pendingModelDisposes: import('monaco-editor').editor.ITextModel[] = [];
        this.multiModelMap.forEach(m => pendingModelDisposes.push(m));
        this.multiModelMap.clear();
        this.originalModelMap.forEach(m => pendingModelDisposes.push(m));
        this.originalModelMap.clear();

        if (this.editor) {
            try {
                // Single-file diff models live on the editor itself, not in
                // our maps — pull them out so we dispose them too.
                if (this.isDiff() && !this.isMultiDiff) {
                    const diffEditor = this.editor as import('monaco-editor').editor.IStandaloneDiffEditor;
                    const model = diffEditor.getModel();
                    if (model) {
                        pendingModelDisposes.push(model.original, model.modified);
                    }
                }

                this.editor.dispose();
                this.editor = null;
            } catch (e) {
                // Editor may already be disposed or in an invalid state, ignore errors
                console.warn('[MonacoEditor] Error during cleanup:', e);
                this.editor = null;
            }
        }

        // Now that the editor (and any DiffEditorWidget) is gone, the models
        // are safe to dispose.
        pendingModelDisposes.forEach(m => {
            try { m.dispose(); } catch { /* ignore */ }
        });
    }

    // ControlValueAccessor methods
    writeValue(value: unknown): void {
        this._value = (value as string) || '';
        if (!this.isInitialized() || !this.editor) return;
        // Multi-file diff: per-file content is driven by switchToFile/files map,
        // not by a single editor-wide value. Ignore writeValue here.
        if (this.isMultiDiff) return;
        if (this.isDiff()) {
            this.updateDiffModels(this.originalValue(), this._value);
            return;
        }
        const codeEditor = this.editor as import('monaco-editor').editor.IStandaloneCodeEditor;
        if (codeEditor.getValue() !== this._value) {
            codeEditor.setValue(this._value);
        }
    }

    registerOnChange(fn: (value: string) => void): void {
        this._onChange = fn;
    }

    registerOnTouched(fn: () => void): void {
        this._onTouched = fn;
    }

    setDisabledState?(isDisabled: boolean): void {
        if (this.editor) {
            this.editor.updateOptions({ readOnly: isDisabled } as import('monaco-editor').editor.IEditorOptions);
        }
    }
}
