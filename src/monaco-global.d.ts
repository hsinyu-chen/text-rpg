import type * as Monaco from 'monaco-editor';

declare global {
    interface Window {
        monaco: typeof Monaco;
        MonacoEnvironment?: {
            getWorker?: (moduleId: string, label: string) => Worker;
            getWorkerUrl?: (moduleId: string, label: string) => string;
            baseUrl?: string;
        };
    }
}

declare module 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js' {
    export const conf: unknown;
    export const language: unknown;
}

declare module 'monaco-editor/esm/vs/basic-languages/json/json.js' {
    export const conf: unknown;
    export const language: unknown;
}
