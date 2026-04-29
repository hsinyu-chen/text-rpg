import { inject, signal } from '@angular/core';
import { WINDOW } from '../../tokens/window.token';
import { StorageService } from '../storage.service';

export type FolderHandlePermissionState = 'unknown' | 'granted' | 'prompt' | 'denied';

export class FolderHandleNoHandleError extends Error {
    constructor() {
        super('No folder bound. Pick a folder first.');
        this.name = 'FolderHandleNoHandleError';
    }
}

export class FolderHandlePermissionDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FolderHandlePermissionDeniedError';
    }
}

/**
 * Owns one FSA handle persisted in IDB under `handleKey`. The browser permission
 * grant does NOT persist across reloads — only the handle itself does. Every
 * public method must therefore run inside a user-gesture call stack so
 * `requestPermission` can surface the prompt.
 */
export abstract class FolderHandleBaseService {
    protected readonly storage = inject(StorageService);
    protected readonly win = inject(WINDOW);
    protected readonly handleKey: string;

    readonly handle = signal<FileSystemDirectoryHandle | null>(null);
    readonly permissionState = signal<FolderHandlePermissionState>('unknown');

    private readonly restoredOnce: Promise<void>;

    constructor(handleKey: string) {
        this.handleKey = handleKey;
        this.restoredOnce = this.restore();
    }

    private async restore(): Promise<void> {
        try {
            const stored = await this.storage.getDirHandle(this.handleKey);
            if (!stored) {
                this.handle.set(null);
                this.permissionState.set('unknown');
                return;
            }
            this.handle.set(stored);
            const state = await stored.queryPermission({ mode: 'readwrite' });
            this.permissionState.set(state);
        } catch (e) {
            console.warn(`[FolderHandle:${this.handleKey}] restore() failed`, e);
            this.handle.set(null);
            this.permissionState.set('unknown');
        }
    }

    async pickFolder(): Promise<FileSystemDirectoryHandle> {
        await this.restoredOnce;
        if (typeof this.win.showDirectoryPicker !== 'function') {
            throw new FolderHandlePermissionDeniedError(
                'File System Access API is not available in this browser.'
            );
        }
        const picked = await this.win.showDirectoryPicker({ mode: 'readwrite' });
        await this.storage.setDirHandle(this.handleKey, picked);
        this.handle.set(picked);
        this.permissionState.set('granted');
        return picked;
    }

    async ensurePermission(): Promise<FileSystemDirectoryHandle> {
        await this.restoredOnce;
        const h = this.handle();
        if (!h) throw new FolderHandleNoHandleError();

        let state = await h.queryPermission({ mode: 'readwrite' });
        if (state !== 'granted') {
            state = await h.requestPermission({ mode: 'readwrite' });
        }
        this.permissionState.set(state);
        if (state !== 'granted') {
            throw new FolderHandlePermissionDeniedError(
                state === 'denied'
                    ? 'Folder access was denied. Re-pick the folder.'
                    : 'Folder access could not be granted. Try again from a user-triggered action.'
            );
        }
        return h;
    }

    async clear(): Promise<void> {
        await this.restoredOnce;
        await this.storage.clearDirHandle(this.handleKey);
        this.handle.set(null);
        this.permissionState.set('unknown');
    }
}
