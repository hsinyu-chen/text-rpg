import { Injectable, inject } from '@angular/core';
import { SyncBackendRegistry } from './sync-backend-registry.service';
import { GoogleDriveService } from '../google-drive.service';
import { GDriveConfigComponent } from './components/gdrive-config.component';
import { S3ConfigComponent } from './components/s3-config.component';
import { FileBackendConfigComponent } from './components/file-backend-config.component';
import { WINDOW } from '../../tokens/window.token';

@Injectable({ providedIn: 'root' })
export class SyncProviderInitService {
    private registry = inject(SyncBackendRegistry);
    private drive = inject(GoogleDriveService);
    private win = inject(WINDOW);

    initialize(): void {
        this.registry.register('gdrive', {
            label: 'Google Drive',
            description: 'Stores in Drive App Data folder.',
            configComponent: GDriveConfigComponent,
            // Show the entry whenever the user can either use existing creds
            // or paste their own — otherwise BYO-OAuth builds would hide the
            // radio before the user has a chance to enter a Client ID.
            isAvailable: () => this.drive.isConfigured || this.drive.isUserConfigurable
        });

        this.registry.register('s3', {
            label: 'S3-compatible',
            description: 'SeaweedFS / MinIO / Cloudflare R2 / AWS S3.',
            configComponent: S3ConfigComponent
        });

        this.registry.register('file', {
            label: 'Local Folder',
            description: 'Sync to a folder on this device. Pair with Dropbox / Syncthing for multi-device.',
            configComponent: FileBackendConfigComponent,
            // File System Access API is Chromium-only as of 2026. Firefox
            // and Safari hide this radio entirely; Chromium / Edge / WebView2
            // show it.
            isAvailable: () => typeof this.win.showDirectoryPicker === 'function'
        });
    }
}
