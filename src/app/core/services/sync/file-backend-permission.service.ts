import { Injectable } from '@angular/core';
import {
    FolderHandleBaseService,
    FolderHandleNoHandleError,
    FolderHandlePermissionDeniedError,
    FolderHandlePermissionState
} from './folder-handle-base.service';

export type FileBackendPermissionState = FolderHandlePermissionState;

export class FileBackendNoHandleError extends FolderHandleNoHandleError {
    constructor() {
        super();
        this.name = 'FileBackendNoHandleError';
    }
}

export class FileBackendPermissionDeniedError extends FolderHandlePermissionDeniedError {
    constructor(message: string) {
        super(message);
        this.name = 'FileBackendPermissionDeniedError';
    }
}

@Injectable({ providedIn: 'root' })
export class FileBackendPermissionService extends FolderHandleBaseService {
    constructor() {
        super('file_root');
    }
}
