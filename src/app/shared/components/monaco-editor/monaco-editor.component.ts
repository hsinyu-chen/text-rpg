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

    // Outputs
    initialized = output<import('monaco-editor').editor.IStandaloneCodeEditor | import('monaco-editor').editor.IStandaloneDiffEditor>();
    valueChange = output<string>();
    activeFileChange = output<string>();

    private editor: import('monaco-editor').editor.IStandaloneCodeEditor | import('monaco-editor').editor.IStandaloneDiffEditor | null = null;
    private resizeObserver?: ResizeObserver;
    private isInitialized = signal(false);

    // Multi-model storage: filename -> ITextModel
    private multiModelMap = new Map<string, import('monaco-editor').editor.ITextModel>();
    private contentChangeDisposable: import('monaco-editor').IDisposable | null = null;

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

            if (!this.isDiff()) {
                const model = (this.editor as import('monaco-editor').editor.IStandaloneCodeEditor).getModel();
                if (model) {
                    window.monaco.editor.setModelLanguage(model, currentLanguage);
                }
            }
        });

        effect(() => {
            if (!this.isInitialized() || !this.editor || !this.isDiff()) return;
            const original = this.originalValue();
            const modified = this._value;

            this.updateDiffModels(original, modified);
        });

        // Effect for multi-model mode: switch active file
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

        const monaco = window.monaco;
        const userOptions = (this.options() as object) || {};

        let commonOptions = {};
        if (this.isDiff()) {
            commonOptions = { ...DEFAULT_DIFF_OPTIONS, ...userOptions };
        } else {
            commonOptions = { ...DEFAULT_OPTIONS, ...userOptions };
        }

        // Language and Theme overrides
        const finalOptions = {
            ...commonOptions,
            theme: this.theme() || (commonOptions as { theme?: string }).theme,
            language: this.language() || (commonOptions as { language?: string }).language,
            automaticLayout: false // We use ResizeObserver so we FORCE this to false regardless of defaults
        };

        if (this.isDiff()) {
            this.editor = monaco.editor.createDiffEditor(el, finalOptions as import('monaco-editor').editor.IDiffEditorConstructionOptions);
            this.updateDiffModels(this.originalValue(), this._value);

            // Listen for changes in the modified model
            const modifiedModel = this.editor.getModel()?.modified;
            if (modifiedModel) {
                modifiedModel.onDidChangeContent(() => {
                    const value = modifiedModel.getValue();
                    this._value = value;
                    this._onChange(value);
                    this.valueChange.emit(value);
                });
            }
        } else {
            this.editor = monaco.editor.create(el, {
                ...finalOptions,
                value: this._value
            } as import('monaco-editor').editor.IStandaloneEditorConstructionOptions);

            // Multi-model mode: create all models upfront
            if (this.multiModelMode()) {
                const filesMap = this.files();
                filesMap.forEach((content, fileName) => {
                    const lang = this.getLanguageFromFilename(fileName);
                    const uri = monaco.Uri.parse(`file:///${fileName.replace(/\\/g, '/')}`);
                    const model = monaco.editor.createModel(content, lang, uri);
                    this.multiModelMap.set(fileName, model);
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

        // Handle Resize
        this.resizeObserver = new ResizeObserver(() => {
            if (this.editor) {
                this.editor.layout();
            }
        });
        this.resizeObserver.observe(el);

        this.isInitialized.set(true);
        this.initialized.emit(this.editor);
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
            if (this.isDiff()) {
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
        if (!this.editor || this.isDiff()) return;

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
        const model = this.multiModelMap.get(fileName);
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

        if (this.isDiff()) {
            const diffEditor = this.editor as import('monaco-editor').editor.IStandaloneDiffEditor;
            // For diff editor, reveal on the modified side
            const modifiedEditor = diffEditor.getModifiedEditor();
            modifiedEditor.revealLineInCenter(lineNumber);
            modifiedEditor.setPosition({ lineNumber, column });
        } else {
            const codeEditor = this.editor as import('monaco-editor').editor.IStandaloneCodeEditor;
            codeEditor.revealLineInCenter(lineNumber);
            codeEditor.setPosition({ lineNumber, column });
        }
    }

    ngOnDestroy() {
        // Dispose content change listener
        if (this.contentChangeDisposable) {
            this.contentChangeDisposable.dispose();
            this.contentChangeDisposable = null;
        }

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }

        // Dispose all multi-model models
        this.multiModelMap.forEach(model => {
            try {
                model.dispose();
            } catch { /* ignore */ }
        });
        this.multiModelMap.clear();

        if (this.editor) {
            try {
                // Dispose models first, then editor
                // Note: Do NOT call setModel(null) on diff editors - it causes Monaco to try to create a new ViewModel
                if (this.isDiff()) {
                    const diffEditor = this.editor as import('monaco-editor').editor.IStandaloneDiffEditor;
                    const model = diffEditor.getModel();
                    // Dispose editor first, then models
                    this.editor.dispose();
                    if (model) {
                        model.original?.dispose();
                        model.modified?.dispose();
                    }
                } else {
                    // For multi-model mode, models are already disposed above, just dispose editor
                    this.editor.dispose();
                }
            } catch (e) {
                // Editor may already be disposed or in an invalid state, ignore errors
                console.warn('[MonacoEditor] Error during cleanup:', e);
            }
            this.editor = null;
        }
    }

    // ControlValueAccessor methods
    writeValue(value: unknown): void {
        this._value = (value as string) || '';
        if (this.isInitialized() && this.editor && !this.isDiff()) {
            const codeEditor = this.editor as import('monaco-editor').editor.IStandaloneCodeEditor;
            if (codeEditor.getValue() !== this._value) {
                codeEditor.setValue(this._value);
            }
        } else if (this.isInitialized() && this.editor && this.isDiff()) {
            this.updateDiffModels(this.originalValue(), this._value);
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
