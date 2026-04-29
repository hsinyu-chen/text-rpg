import { Injectable, inject } from '@angular/core';
import { StorageService } from '../storage.service';
import { ALL_PROMPT_TYPES, InjectionService, type PromptType } from '../injection.service';
import { GameStateService } from '../game-state.service';
import { PromptProfileRegistryService } from '../prompt-profile-registry.service';
import { DiskProfileFolderService } from './disk-profile-folder.service';
import { ensureDir, getDirIfExists, readFileText, writeFileText } from './fsa-utils';

/**
 * On-disk profile envelope. `version` is bumped if the file layout ever
 * changes (e.g. additional fields per type, or split into per-type sidecars).
 */
interface DiskProfileEnvelope {
    version: 2;
    profile: {
        id: string;
        displayName: string;
        baseProfileId: string;
        createdAt: number;
        updatedAt: number;
    };
}

const ENVELOPE_FILENAME = 'profile.json';
const TYPE_FILENAME: Record<PromptType, string> = {
    action: 'action.md',
    continue: 'continue.md',
    fastforward: 'fastforward.md',
    system: 'system.md',
    save: 'save.md',
    system_main: 'system_main.md',
    postprocess: 'postprocess.js'
};

/**
 * Mirrors a single user profile to a directory on disk so it can be edited
 * with an external editor (Claude Code, VS Code, …) and pulled back into
 * IDB. Built-in profiles are not supported (they're always read-only and
 * shipped as assets).
 *
 * Layout under the bound root:
 *   <root>/<profileId>/profile.json     ← envelope (v2)
 *   <root>/<profileId>/<type>.md / .js  ← one file per PromptType
 *
 * Single-direction operations only — Push overwrites disk, Pull overwrites
 * IDB. No watch, no merge. Conflicts are resolved by which button you press.
 */
@Injectable({ providedIn: 'root' })
export class DiskProfileSyncService {
    private storage = inject(StorageService);
    private injection = inject(InjectionService);
    private state = inject(GameStateService);
    private registry = inject(PromptProfileRegistryService);
    private folder = inject(DiskProfileFolderService);

    /** Replace user-visible folder; subsequent push/pull use the new handle. */
    async pickFolder(): Promise<void> {
        await this.folder.pickFolder();
    }

    /**
     * Currently bound folder name (or null if unbound). For tooltips / UI
     * labels — not the full path, FSA hides those.
     */
    boundFolderName(): string | null {
        return this.folder.handle()?.name ?? null;
    }

    /**
     * Push the currently active user profile to disk. Throws if the active
     * profile is built-in or unknown, or the folder isn't bound / accessible.
     */
    async pushActiveToDisk(): Promise<void> {
        const profile = this.assertActiveUserProfile();
        const root = await this.folder.ensurePermission();
        const dir = await ensureDir(root, [profile.id]);

        const envelope: DiskProfileEnvelope = {
            version: 2,
            profile: {
                id: profile.id,
                displayName: profile.displayName ?? profile.id,
                baseProfileId: profile.baseProfileId ?? 'cloud',
                createdAt: profile.createdAt ?? Date.now(),
                updatedAt: Date.now()
            }
        };
        await writeFileText(dir, ENVELOPE_FILENAME, JSON.stringify(envelope, null, 2));

        for (const type of ALL_PROMPT_TYPES) {
            const row = await this.storage.getProfilePrompt(type, profile.id);
            const content = row?.content ?? '';
            await writeFileText(dir, TYPE_FILENAME[type], content);
        }
    }

    /**
     * Pull the active user profile's content from disk into IDB and reload
     * the live signals. Files that don't exist on disk leave their IDB row
     * untouched (so a partial edit set works without zeroing the rest). The
     * envelope's metadata is also synced into IDB if present, so renames
     * round-trip.
     */
    async pullActiveFromDisk(): Promise<{ updatedTypes: number; metaUpdated: boolean }> {
        const profile = this.assertActiveUserProfile();
        const root = await this.folder.ensurePermission();
        const dir = await getDirIfExists(root, [profile.id]);
        if (!dir) {
            throw new Error(`Disk profile folder for '${profile.id}' does not exist yet — push first.`);
        }

        let metaUpdated = false;
        const envelopeText = await readFileText(dir, ENVELOPE_FILENAME);
        if (envelopeText) {
            try {
                const parsed = JSON.parse(envelopeText) as DiskProfileEnvelope;
                if (parsed.version === 2 && parsed.profile?.id === profile.id) {
                    const meta = {
                        id: profile.id,
                        displayName: parsed.profile.displayName || profile.displayName || profile.id,
                        baseProfileId: parsed.profile.baseProfileId || profile.baseProfileId || 'cloud',
                        createdAt: parsed.profile.createdAt || profile.createdAt || Date.now(),
                        updatedAt: Date.now()
                    };
                    await this.storage.putProfileMeta(meta);
                    this.registry.update(profile.id, {
                        displayName: meta.displayName,
                        baseProfileId: meta.baseProfileId,
                        updatedAt: meta.updatedAt
                    });
                    metaUpdated = true;
                }
            } catch (err) {
                console.warn('[DiskProfileSync] envelope parse failed; skipping meta update', err);
            }
        }

        let updatedTypes = 0;
        for (const type of ALL_PROMPT_TYPES) {
            const text = await readFileText(dir, TYPE_FILENAME[type]);
            if (text === null) continue;
            await this.storage.saveProfilePrompt(type, profile.id, text);
            updatedTypes++;
        }

        // Force a fresh load so live signals + dirty checks pick up the new
        // content. forceReload resets both guards so a previous in-flight or
        // marked-done load doesn't short-circuit the re-read.
        await this.injection.forceReload();
        return { updatedTypes, metaUpdated };
    }

    private assertActiveUserProfile() {
        const id = this.state.activePromptProfile();
        const profile = this.registry.get(id);
        if (!profile) throw new Error(`Active profile '${id}' is not registered.`);
        if (profile.isBuiltIn) throw new Error('Disk sync is only supported for user profiles.');
        return profile;
    }
}
