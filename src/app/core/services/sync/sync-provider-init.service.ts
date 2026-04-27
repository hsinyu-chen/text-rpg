import { Injectable, inject } from '@angular/core';
import { SyncBackendRegistry } from './sync-backend-registry.service';
import { GoogleDriveService } from '../google-drive.service';
import { GDriveConfigComponent } from './components/gdrive-config.component';
import { S3ConfigComponent } from './components/s3-config.component';

@Injectable({ providedIn: 'root' })
export class SyncProviderInitService {
    private registry = inject(SyncBackendRegistry);
    private drive = inject(GoogleDriveService);

    initialize(): void {
        this.registry.register('gdrive', {
            label: 'Google Drive',
            description: 'Stores in Drive App Data folder.',
            configComponent: GDriveConfigComponent,
            isAvailable: () => this.drive.isConfigured
        });

        this.registry.register('s3', {
            label: 'S3-compatible',
            description: 'SeaweedFS / MinIO / Cloudflare R2 / AWS S3.',
            configComponent: S3ConfigComponent
        });
    }
}
