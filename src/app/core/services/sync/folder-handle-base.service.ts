import { inject, signal } from '@angular/core';
import { WINDOW } from '@app/core/tokens/window.token';
import { DirHandleRepository } from '../storage/dir-handle.repository';

export type FolderHandlePermissionState = 'unknown' | 'granted' | 'prompt' | 'denied';

export class FolderHandleNoHandleError extends Error {
    constructor() {
        super('No folder bound. Pick a folder first.');
        this.name = 'FolderHandleNoHandleError';
    }
}

export class FolderHandlePermissionDeniedError extends Error {
    /**
     * Translation key (e.g. 'sync.file.errAccessDenied') that the UI layer
     * passes through I18nService. The Error.message is set to the same key
     * as a developer-readable fallback for logs / non-localized callers.
     */
    constructor(readonly messageKey: string) {
        super(messageKey);
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
    protected readonly handles = inject(DirHandleRepository);
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
            const stored = await this.handles.get(this.handleKey);
            if (!stored) return; // initial signal values (null / 'unknown') already correct
            // Atomic publish: query permission BEFORE writing either signal,
            // so observers (e.g. AutoSyncScheduler's fingerprint effect)
            // never see the (handle=bound, state=unknown) intermediate that
            // would look like an auth lapse and trip auto-disable logic.
            const state = await stored.queryPermission({ mode: 'readwrite' });
            this.handle.set(stored);
            this.permissionState.set(state);
        } catch (e) {
            console.warn(`[FolderHandle:${this.handleKey}] restore() failed`, e);
        }
    }

    async pickFolder(): Promise<FileSystemDirectoryHandle> {
        await this.restoredOnce;
        if (typeof this.win.showDirectoryPicker !== 'function') {
            throw new FolderHandlePermissionDeniedError('sync.file.errFsaUnavailable');
        }
        const picked = await this.win.showDirectoryPicker({ mode: 'readwrite' });
        await this.handles.set(this.handleKey, picked);
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
                    ? 'sync.file.errAccessDenied'
                    : 'sync.file.errAccessNotGranted'
            );
        }
        return h;
    }

    async clear(): Promise<void> {
        await this.restoredOnce;
        await this.handles.delete(this.handleKey);
        this.handle.set(null);
        this.permissionState.set('unknown');
    }
}
