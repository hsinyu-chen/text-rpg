import { InjectionToken, Provider } from '@angular/core';
import { SyncBackend } from './sync.types';
import { GDriveSyncBackend } from './gdrive-sync-backend';
import { FileSyncBackend } from './file-sync-backend';
import { S3SyncBackend } from './s3-sync-backend';

/**
 * Multi-provider list of every backend the app knows about. The
 * `SyncBackendResolver` finds the active one by id at runtime — adding
 * a new backend means appending one provider here, no ladder edits.
 *
 * Order matters only for the "default if no preference saved" fallback,
 * which lives in `SyncBackendResolver`, not here.
 */
export const SYNC_BACKENDS = new InjectionToken<readonly SyncBackend[]>('SYNC_BACKENDS');

export const SYNC_BACKEND_PROVIDERS: Provider[] = [
    { provide: SYNC_BACKENDS, useExisting: GDriveSyncBackend, multi: true },
    { provide: SYNC_BACKENDS, useExisting: FileSyncBackend, multi: true },
    { provide: SYNC_BACKENDS, useExisting: S3SyncBackend, multi: true }
];
