import { Injectable, inject } from '@angular/core';
import { StorageService } from '../storage.service';
import { ALL_PROMPT_TYPES, InjectionService, type PromptType } from '../injection.service';
import { GameStateService } from '../game-state.service';
import { PromptProfileRegistryService } from '../prompt-profile-registry.service';
import { DiskProfileFolderService } from './disk-profile-folder.service';
import { ensureDir, getDirIfExists, readFileText, writeFileText } from './fsa-utils';

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
 * Single-direction sync. Push overwrites disk, Pull overwrites IDB. Built-in
 * profiles are rejected — they're shipped as assets and have no IDB row to mirror.
 */
@Injectable({ providedIn: 'root' })
export class DiskProfileSyncService {
    private storage = inject(StorageService);
    private injection = inject(InjectionService);
    private state = inject(GameStateService);
    private registry = inject(PromptProfileRegistryService);
    private folder = inject(DiskProfileFolderService);

    async pickFolder(): Promise<void> {
        await this.folder.pickFolder();
    }

    /** FSA hides full paths — only the folder name is exposed. */
    boundFolderName(): string | null {
        return this.folder.handle()?.name ?? null;
    }

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

    /** Files absent on disk leave their IDB row untouched — partial edit sets don't zero the rest. */
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
