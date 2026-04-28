import { Injectable, inject, signal } from '@angular/core';
import { WINDOW } from '../../tokens/window.token';
import { StorageService } from '../storage.service';

const HANDLE_KEY = 'file_root';

export type FileBackendPermissionState = 'unknown' | 'granted' | 'prompt' | 'denied';

/**
 * Thrown by `ensurePermission` when no folder has been picked yet. The UI
 * should route the user to the Settings page to bind a folder.
 */
export class FileBackendNoHandleError extends Error {
    constructor() {
        super('File sync backend has no folder bound. Pick a folder in Settings first.');
        this.name = 'FileBackendNoHandleError';
    }
}

/**
 * Thrown by `ensurePermission` when the browser refused readwrite access to
 * the bound folder (user cancelled the prompt, or the folder no longer
 * exists / has been moved).
 */
export class FileBackendPermissionDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileBackendPermissionDeniedError';
    }
}

/**
 * Owns the FileSystemDirectoryHandle that the file sync backend operates on.
 *
 * Persistence model:
 *   - The handle itself round-trips via IDB structured-clone (same-origin) so
 *     it survives reload.
 *   - The browser's permission grant does NOT persist — `queryPermission`
 *     returns 'prompt' on a fresh tab even when a handle was restored.
 *   - To re-acquire 'granted' we must call `requestPermission`, which only
 *     works inside a user-gesture call stack.
 *
 * Why this is fine without any banner / boot-time prompt: the file backend
 * is `supportsBackgroundSync = false`, so every sync attempt starts from a
 * user click (Sync All / Force Push / Snapshot). `ensurePermission` runs
 * inside that click's transient activation window, so the prompt fires
 * naturally on the first action of each tab session.
 */
@Injectable({ providedIn: 'root' })
export class FileBackendPermissionService {
    private readonly storage = inject(StorageService);
    private readonly win = inject(WINDOW);

    readonly handle = signal<FileSystemDirectoryHandle | null>(null);
    readonly permissionState = signal<FileBackendPermissionState>('unknown');

    /** Single-flight restore promise; awaited by every public method so the
     *  IDB hydration and signal initialization happens once. */
    private readonly restoredOnce: Promise<void> = this.restore();

    private async restore(): Promise<void> {
        try {
            const stored = await this.storage.getDirHandle(HANDLE_KEY);
            if (!stored) {
                this.handle.set(null);
                this.permissionState.set('unknown');
                return;
            }
            this.handle.set(stored);
            const state = await stored.queryPermission({ mode: 'readwrite' });
            this.permissionState.set(state);
        } catch (e) {
            // Hydration failure shouldn't crash the app; user can re-pick.
            console.warn('[FileBackendPermission] restore() failed', e);
            this.handle.set(null);
            this.permissionState.set('unknown');
        }
    }

    /**
     * Opens the directory picker. Must be invoked from a user-gesture handler.
     * Persists the resulting handle to IDB and marks state 'granted'.
     */
    async pickFolder(): Promise<FileSystemDirectoryHandle> {
        await this.restoredOnce;
        if (typeof this.win.showDirectoryPicker !== 'function') {
            throw new FileBackendPermissionDeniedError(
                'File System Access API is not available in this browser.'
            );
        }
        const picked = await this.win.showDirectoryPicker({ mode: 'readwrite' });
        await this.storage.setDirHandle(HANDLE_KEY, picked);
        this.handle.set(picked);
        this.permissionState.set('granted');
        return picked;
    }

    /**
     * Asserts the bound folder is reachable and writable. Call from any
     * sync entry point that runs under a user-gesture call stack — if the
     * permission state is 'prompt', this fires `requestPermission` which
     * needs that activation to surface the browser prompt.
     */
    async ensurePermission(): Promise<FileSystemDirectoryHandle> {
        await this.restoredOnce;
        const h = this.handle();
        if (!h) throw new FileBackendNoHandleError();

        let state = await h.queryPermission({ mode: 'readwrite' });
        if (state !== 'granted') {
            state = await h.requestPermission({ mode: 'readwrite' });
        }
        this.permissionState.set(state);
        if (state !== 'granted') {
            throw new FileBackendPermissionDeniedError(
                state === 'denied'
                    ? 'Folder access was denied. Re-pick the folder in Settings.'
                    : 'Folder access could not be granted. Try again from a sync action.'
            );
        }
        return h;
    }

    /** Forgets the bound folder. Used by Settings "Unbind" / repick flows. */
    async clear(): Promise<void> {
        await this.restoredOnce;
        await this.storage.clearDirHandle(HANDLE_KEY);
        this.handle.set(null);
        this.permissionState.set('unknown');
    }
}
