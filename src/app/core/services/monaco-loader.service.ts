import { Injectable, signal } from '@angular/core';
@Injectable({
    providedIn: 'root'
})
export class MonacoLoaderService {
    private isLoaded = signal(false);
    private loadingPromise: Promise<typeof import('monaco-editor')> | null = null;
    private monacoInstance: typeof import('monaco-editor') | null = null;

    async load(): Promise<typeof import('monaco-editor')> {
        const monaco = await import('monaco-editor');
        window.MonacoEnvironment = {
            getWorkerUrl: (_moduleId: string, label: string) => {
                const base = '/assets/monaco/esm/vs';
                if (label === 'json') return `${base}/language/json/json.worker.js`;
                if (label === 'css' || label === 'scss' || label === 'less') return `${base}/language/css/css.worker.js`;
                if (label === 'html' || label === 'handlebars' || label === 'razor') return `${base}/language/html/html.worker.js`;
                if (label === 'typescript' || label === 'javascript') return `${base}/language/typescript/ts.worker.js`;
                return `${base}/editor/editor.worker.js`;
            }
        };

        // Dynamically inject Monaco CSS if not already present
        this.injectMonacoCss();

        if (this.monacoInstance) return this.monacoInstance;
        if (this.loadingPromise) return this.loadingPromise;

        this.loadingPromise = (async () => {
            if (window.monaco) {
                this.monacoInstance = window.monaco;
                this.isLoaded.set(true);
                return this.monacoInstance;
            }
            this.monacoInstance = monaco;
            window.monaco = monaco;


            this.isLoaded.set(true);
            return monaco;
        })();

        return this.loadingPromise;
    }

    /** Dynamically inject Monaco editor CSS to avoid Vite build warning */
    private injectMonacoCss(): void {
        const cssId = 'monaco-editor-css';
        if (document.getElementById(cssId)) return; // Already injected

        const link = document.createElement('link');
        link.id = cssId;
        link.rel = 'stylesheet';
        link.setAttribute('data-name', 'vs/editor/editor.main');
        link.href = 'assets/monaco/min/vs/editor/editor.main.css';
        document.head.appendChild(link);
    }

    getLoadedSignal() {
        return this.isLoaded;
    }
}
