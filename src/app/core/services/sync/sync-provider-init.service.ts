import { Injectable, inject } from '@angular/core';
import { SyncBackendRegistry } from './sync-backend-registry.service';
import { GoogleOAuthService } from '../google-oauth.service';
import { GDriveConfigComponent } from './gdrive/components/gdrive-config.component';
import { S3ConfigComponent } from './s3/components/s3-config.component';
import { FileBackendConfigComponent } from './file/components/file-backend-config.component';
import { WINDOW } from '@app/core/tokens/window.token';

@Injectable({ providedIn: 'root' })
export class SyncProviderInitService {
    private registry = inject(SyncBackendRegistry);
    private oauth = inject(GoogleOAuthService);
    private win = inject(WINDOW);

    initialize(): void {
        this.registry.register('gdrive', {
            label: 'Google Drive',
            description: 'sync.provider.gdriveDescription',
            configComponent: GDriveConfigComponent,
            // Show the entry whenever the user can either use existing creds
            // or paste their own — otherwise BYO-OAuth builds would hide the
            // radio before the user has a chance to enter a Client ID.
            isAvailable: () => this.oauth.isConfigured || this.oauth.isUserConfigurable
        });

        this.registry.register('s3', {
            label: 'S3-compatible',
            description: 'sync.provider.s3Description',
            configComponent: S3ConfigComponent
        });

        this.registry.register('file', {
            label: 'Local Folder',
            description: 'sync.provider.fileDescription',
            configComponent: FileBackendConfigComponent,
            // File System Access API is Chromium-only as of 2026. Firefox
            // and Safari hide this radio entirely; Chromium / Edge / WebView2
            // show it.
            isAvailable: () => typeof this.win.showDirectoryPicker === 'function'
        });
    }
}
