import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { GoogleDriveService } from './google-drive.service';
import { LoadingService } from './loading.service';

const SETTINGS_FILE_NAME = 'settings.json';
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
    private drive = inject(GoogleDriveService);
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
        this.loading.show('Uploading settings to Cloud...');
        try {
            if (!this.drive.isAuthenticated()) {
                await this.drive.login();
            }

            const snapshot = this.buildSnapshot();
            const content = JSON.stringify(snapshot, null, 2);

            const files = await this.drive.listFiles('appDataFolder');
            const existing = files.find(f => f.name === SETTINGS_FILE_NAME);

            if (existing) {
                await this.drive.updateFile(existing.id, content);
            } else {
                await this.drive.createFile('appDataFolder', SETTINGS_FILE_NAME, content);
            }

            const count = Object.keys(snapshot.entries).length;
            this.snackBar.open(`Settings uploaded (${count} entries).`, 'OK', { duration: 3000 });
        } catch (error) {
            console.error('[SettingsSync] Upload failed', error);
            this.handleAuthError('Upload failed. Click to re-authenticate.');
            throw error;
        } finally {
            this.loading.hide();
        }
    }

    async download(): Promise<boolean> {
        this.loading.show('Downloading settings from Cloud...');
        try {
            if (!this.drive.isAuthenticated()) {
                await this.drive.login();
            }

            const files = await this.drive.listFiles('appDataFolder');
            const settingsFile = files.find(f => f.name === SETTINGS_FILE_NAME);

            if (!settingsFile) {
                this.snackBar.open('No settings found in Cloud.', 'Close', { duration: 3000 });
                return false;
            }

            const content = await this.drive.readFile(settingsFile.id);
            const snapshot = JSON.parse(content) as SettingsSnapshot;
            const applied = this.applySnapshot(snapshot);

            this.snackBar.open(`Imported ${applied} settings. Reloading...`, 'OK', { duration: 2500 });
            // Reload so every service re-reads localStorage from a clean state.
            setTimeout(() => window.location.reload(), 800);
            return true;
        } catch (error) {
            console.error('[SettingsSync] Download failed', error);
            this.handleAuthError('Download failed. Click to re-authenticate.');
            throw error;
        } finally {
            this.loading.hide();
        }
    }

    private handleAuthError(message: string): void {
        localStorage.removeItem('gdrive_access_token');
        const snackRef = this.snackBar.open(message, 'Re-Auth', { duration: 10000 });
        firstValueFrom(snackRef.onAction()).then(async () => {
            try {
                await this.drive.login();
                this.snackBar.open('Re-authenticated. Please try again.', 'OK', { duration: 3000 });
            } catch {
                this.snackBar.open('Re-authentication failed.', 'Close', { duration: 3000 });
            }
        });
    }
}
