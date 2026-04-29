import { Injectable } from '@angular/core';
import { FolderHandleBaseService } from './folder-handle-base.service';

@Injectable({ providedIn: 'root' })
export class DiskProfileFolderService extends FolderHandleBaseService {
    constructor() {
        super('disk_profile_sync');
    }
}
