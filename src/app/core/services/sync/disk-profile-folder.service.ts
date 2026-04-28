import { Injectable } from '@angular/core';
import { FolderHandleBaseService } from './folder-handle-base.service';

/**
 * Owns the FileSystemDirectoryHandle for the disk profile sync feature
 * (live-tuning workflow: mirror active profile to disk, edit `.md` files
 * externally, then pull back into IDB). Independent from
 * `FileBackendPermissionService` so the user can bind a different folder.
 */
@Injectable({ providedIn: 'root' })
export class DiskProfileFolderService extends FolderHandleBaseService {
    constructor() {
        super('disk_profile_sync');
    }
}
