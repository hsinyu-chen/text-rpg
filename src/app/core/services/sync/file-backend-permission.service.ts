import { Injectable } from '@angular/core';
import {
    FolderHandleBaseService,
    FolderHandleNoHandleError,
    FolderHandlePermissionDeniedError,
    FolderHandlePermissionState
} from './folder-handle-base.service';

export type FileBackendPermissionState = FolderHandlePermissionState;

/**
 * Thrown by `ensurePermission` when no folder has been picked yet. The UI
 * should route the user to the Settings page to bind a folder.
 */
export class FileBackendNoHandleError extends FolderHandleNoHandleError {
    constructor() {
        super();
        this.name = 'FileBackendNoHandleError';
    }
}

/**
 * Thrown by `ensurePermission` when the browser refused readwrite access to
 * the bound folder (user cancelled the prompt, or the folder no longer
 * exists / has been moved).
 */
export class FileBackendPermissionDeniedError extends FolderHandlePermissionDeniedError {
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
 *
 * Implementation lives in `FolderHandleBaseService`; this subclass just pins
 * the IDB key and re-exports the legacy error class names so existing
 * imports keep compiling.
 */
@Injectable({ providedIn: 'root' })
export class FileBackendPermissionService extends FolderHandleBaseService {
    constructor() {
        super('file_root');
    }
}
