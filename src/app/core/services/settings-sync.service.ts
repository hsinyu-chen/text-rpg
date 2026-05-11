import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LoadingService } from './loading.service';
import { SyncService } from './sync/sync.service';
import { WINDOW } from '../tokens/window.token';
import { KVStore } from './kv/kv-store';
import { I18nService } from '../i18n';

const SNAPSHOT_VERSION = 1;

// Exact keys and prefixes that represent portable user settings.
// Common app config only — LLM provider config now lives in IndexedDB profiles
// owned by LLMConfigService and is synced through its own backend.
const SYNC_EXACT_KEYS: ReadonlySet<string> = new Set();
const SYNC_PREFIXES: readonly string[] = ['app_'];

// Explicit deny list — keys that match prefixes above but must not be synced
// (e.g. volatile runtime/session state or device-specific caches).
const SYNC_DENY_EXACT: ReadonlySet<string> = new Set<string>();

export interface SettingsSnapshot {
    version: number;
    exportedAt: string;
    entries: Record<string, string>;
}

function isSyncKey(key: string): boolean {
    if (SYNC_DENY_EXACT.has(key)) return false;
    if (SYNC_EXACT_KEYS.has(key)) return true;
    return SYNC_PREFIXES.some(p => key.startsWith(p));
}

@Injectable({ providedIn: 'root' })
export class SettingsSyncService {
    private sync = inject(SyncService);
    private loading = inject(LoadingService);
    private snackBar = inject(MatSnackBar);
    private readonly win = inject(WINDOW);
    private kv = inject(KVStore);
    private i18n = inject(I18nService);

    buildSnapshot(): SettingsSnapshot {
        const entries: Record<string, string> = {};
        for (const key of this.kv.keys()) {
            if (!isSyncKey(key)) continue;
            const value = this.kv.get(key);
            if (value !== null) entries[key] = value;
        }
        return {
            version: SNAPSHOT_VERSION,
            exportedAt: new Date().toISOString(),
            entries
        };
    }

    applySnapshot(snapshot: SettingsSnapshot): number {
        if (!snapshot || typeof snapshot !== 'object' || !snapshot.entries || typeof snapshot.entries !== 'object') {
            throw new Error('Invalid snapshot payload');
        }

        // Remove local keys in the sync scope that are missing from the snapshot,
        // so the device ends up matching the cloud source of truth exactly.
        for (const k of this.kv.keys()) {
            if (isSyncKey(k) && !(k in snapshot.entries)) this.kv.remove(k);
        }

        let applied = 0;
        for (const [key, value] of Object.entries(snapshot.entries)) {
            if (!isSyncKey(key)) continue; // ignore unexpected keys in payload
            if (typeof value !== 'string') continue;
            this.kv.set(key, value);
            applied++;
        }
        return applied;
    }

    async upload(): Promise<void> {
        this.loading.show(this.i18n.translate('settings.snapshotUploadingProgress'));
        try {
            const snapshot = this.buildSnapshot();
            const content = JSON.stringify(snapshot, null, 2);
            await this.sync.uploadSettings(content);
            const count = Object.keys(snapshot.entries).length;
            this.snackBar.open(this.i18n.translate('settings.snapshotUploadOK', { count }), this.i18n.translate('dialog.ok'), { duration: 3000 });
        } catch (error) {
            console.error('[SettingsSync] Upload failed', error);
            this.snackBar.open(this.i18n.translate('settings.snapshotUploadFailed', { error: (error as { message?: string })?.message || this.i18n.translate('sync.common.unknownError') }), this.i18n.translate('ui.CLOSE'), { duration: 5000 });
            throw error;
        } finally {
            this.loading.hide();
        }
    }

    async download(): Promise<boolean> {
        this.loading.show(this.i18n.translate('settings.snapshotDownloadingProgress'));
        try {
            const content = await this.sync.downloadSettings();
            if (!content) {
                this.snackBar.open(this.i18n.translate('settings.snapshotNoneFound'), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
                return false;
            }
            const snapshot = JSON.parse(content) as SettingsSnapshot;
            const applied = this.applySnapshot(snapshot);

            this.snackBar.open(this.i18n.translate('settings.snapshotImportedReloading', { count: applied }), this.i18n.translate('dialog.ok'), { duration: 2500 });
            setTimeout(() => this.win.location.reload(), 800);
            return true;
        } catch (error) {
            console.error('[SettingsSync] Download failed', error);
            this.snackBar.open(this.i18n.translate('settings.snapshotDownloadFailed', { error: (error as { message?: string })?.message || this.i18n.translate('sync.common.unknownError') }), this.i18n.translate('ui.CLOSE'), { duration: 5000 });
            throw error;
        } finally {
            this.loading.hide();
        }
    }
}
