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
 * Base for any service that owns a single FileSystemDirectoryHandle persisted
 * in IDB under a fixed key. Subclasses set `handleKey` and may rename / wrap
 * methods. Persistence model and the user-gesture requirement are identical
 * to the original FileBackendPermissionService — see that subclass for the
 * full explanation.
 */
export abstract class FolderHandleBaseService {
    protected readonly storage = inject(StorageService);
    protected readonly win = inject(WINDOW);

    protected abstract readonly handleKey: string;

    readonly handle = signal<FileSystemDirectoryHandle | null>(null);
    readonly permissionState = signal<FolderHandlePermissionState>('unknown');

    /** Single-flight restore — awaited by every public method. */
    private restoredOnce: Promise<void> | null = null;

    private restorePromise(): Promise<void> {
        if (!this.restoredOnce) this.restoredOnce = this.restore();
        return this.restoredOnce;
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

    /** Opens the directory picker. Must be invoked from a user-gesture handler. */
    async pickFolder(): Promise<FileSystemDirectoryHandle> {
        await this.restorePromise();
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

    /** Asserts the bound folder is reachable and writable; prompts if needed. */
    async ensurePermission(): Promise<FileSystemDirectoryHandle> {
        await this.restorePromise();
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

    /** Forgets the bound folder. */
    async clear(): Promise<void> {
        await this.restorePromise();
        await this.storage.clearDirHandle(this.handleKey);
        this.handle.set(null);
        this.permissionState.set('unknown');
    }
}
