import { Injectable, inject } from '@angular/core';
import { I18nService } from '@app/core/i18n/i18n.service';
import { S3Config } from '../sync.types';
import { S3ClientService } from './s3-client.service';
import { S3BlobStore } from './s3-blob-store';
import { entryPath, entryDirPrefix } from '../layout/sync-paths';
import { SLASH_TOMBSTONE_LAYOUT } from '../domain/tombstone-repository';
import { GenericSyncBackend } from '../generic-sync-backend';

/**
 * S3-flavoured `SyncBackend`. The class exists only to surface a DI token
 * (`inject(S3SyncBackend)`) and host the S3-specific `testConfig` UI
 * helper — every actual sync operation lives in {@link GenericSyncBackend}
 * and is parameterised by the config below.
 */
@Injectable({ providedIn: 'root' })
export class S3SyncBackend extends GenericSyncBackend {
    private readonly clientSvc: S3ClientService;

    constructor() {
        const blob = inject(S3BlobStore);
        const clientSvc = inject(S3ClientService);
        const i18n = inject(I18nService);
        super({
            id: 's3',
            label: 'S3-compatible',
            authActionLabel: i18n.translate('sync.s3.authenticateBtn'),
            supportsBackgroundSync: true,
            blob,
            lifecycle: clientSvc,
            entryPathFor: entryPath,
            entryDirPrefix,
            tombstoneLayout: SLASH_TOMBSTONE_LAYOUT
        });
        this.clientSvc = clientSvc;
    }

    /** UI helper: validate a candidate config without binding the singleton. */
    testConfig(config: S3Config): Promise<void> {
        return this.clientSvc.testConfig(config);
    }
}
