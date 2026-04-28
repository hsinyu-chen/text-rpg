/* eslint-disable no-restricted-syntax -- TODO(dom-cleanup): migrate window.location.reload to inject(WINDOW) */
import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LoadingService } from './loading.service';
import { SyncService } from './sync/sync.service';

const SNAPSHOT_VERSION = 1;

// Exact keys and prefixes that represent portable user settings.
// Active provider selection + common app config + each LLM provider's config.
const SYNC_EXACT_KEYS: ReadonlySet<string> = new Set(['llm_provider']);
const SYNC_PREFIXES: readonly string[] = ['app_', 'gemini_', 'llama_', 'openai_'];

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

    buildSnapshot(): SettingsSnapshot {
        const entries: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !isSyncKey(key)) continue;
            const value = localStorage.getItem(key);
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
        const existingKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && isSyncKey(k)) existingKeys.push(k);
        }
        for (const k of existingKeys) {
            if (!(k in snapshot.entries)) localStorage.removeItem(k);
        }

        let applied = 0;
        for (const [key, value] of Object.entries(snapshot.entries)) {
            if (!isSyncKey(key)) continue; // ignore unexpected keys in payload
            if (typeof value !== 'string') continue;
            localStorage.setItem(key, value);
            applied++;
        }
        return applied;
    }

    async upload(): Promise<void> {
        this.loading.show('Uploading settings...');
        try {
            const snapshot = this.buildSnapshot();
            const content = JSON.stringify(snapshot, null, 2);
            await this.sync.uploadSettings(content);
            const count = Object.keys(snapshot.entries).length;
            this.snackBar.open(`Settings uploaded (${count} entries).`, 'OK', { duration: 3000 });
        } catch (error) {
            console.error('[SettingsSync] Upload failed', error);
            this.snackBar.open('Settings upload failed: ' + ((error as { message?: string })?.message || ''), 'Close', { duration: 5000 });
            throw error;
        } finally {
            this.loading.hide();
        }
    }

    async download(): Promise<boolean> {
        this.loading.show('Downloading settings...');
        try {
            const content = await this.sync.downloadSettings();
            if (!content) {
                this.snackBar.open('No settings found on the active sync provider.', 'Close', { duration: 3000 });
                return false;
            }
            const snapshot = JSON.parse(content) as SettingsSnapshot;
            const applied = this.applySnapshot(snapshot);

            this.snackBar.open(`Imported ${applied} settings. Reloading...`, 'OK', { duration: 2500 });
            setTimeout(() => window.location.reload(), 800);
            return true;
        } catch (error) {
            console.error('[SettingsSync] Download failed', error);
            this.snackBar.open('Settings download failed: ' + ((error as { message?: string })?.message || ''), 'Close', { duration: 5000 });
            throw error;
        } finally {
            this.loading.hide();
        }
    }
}
