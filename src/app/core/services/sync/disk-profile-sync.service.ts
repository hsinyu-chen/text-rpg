import { Injectable, inject } from '@angular/core';
import { PromptRepository } from '../storage/prompt.repository';
import { ProfileMetaRepository } from '../storage/profile-meta.repository';
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
const HUNKS_FILENAME = 'hunks.json';
const TYPE_FILENAME: Record<PromptType, string> = {
    action: 'action.md',
    continue: 'continue.md',
    fastforward: 'fastforward.md',
    system: 'system.md',
    system_main: 'system_main.md',
    postprocess: 'postprocess.js',
    protocol_single: 'protocol_single.md',
    protocol_resolver: 'protocol_resolver.md',
    protocol_narrator: 'protocol_narrator.md',
    correction: 'correction.md',
    save_manifest: 'save_manifest.md',
    save_inventory_consistency: 'save_inventory_consistency.md',
    save_character_state: 'save_character_state.md',
    save_faction_state: 'save_faction_state.md',
    save_character_triage: 'save_character_triage.md',
    save_faction_triage: 'save_faction_triage.md'
};

/**
 * Single-direction sync. Push overwrites disk, Pull overwrites IDB. A built-in
 * profile's base prompts are shipped assets with no IDB row to mirror, so for
 * built-ins only the local hunk overlay (`hunks.json`) is synced — never the
 * base files or the profile envelope. User profiles sync in full.
 */
@Injectable({ providedIn: 'root' })
export class DiskProfileSyncService {
    private prompts = inject(PromptRepository);
    private profileMeta = inject(ProfileMetaRepository);
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

    /**
     * Touches the folder handle's permission without committing to a read or
     * write. Chrome only offers the "Always allow on this site" checkbox in
     * the FSA dialog when the requestPermission call is pure (no immediate
     * I/O follows) — push/pull bundle the permission ask with the action and
     * Chrome falls back to a single-shot "Allow". Call this from a click
     * handler after a reload to upgrade the handle to persistent permission.
     */
    async ensureFolderPermission(): Promise<void> {
        this.assertActiveProfile();
        await this.folder.ensurePermission();
    }

    async pushActiveToDisk(): Promise<void> {
        const profile = this.assertActiveProfile();
        const root = await this.folder.ensurePermission();
        const dir = await ensureDir(root, [profile.id]);

        const hunks = await this.prompts.getAllProfileHunks(profile.id, ALL_PROMPT_TYPES);

        if (profile.isBuiltIn) {
            // Built-ins ship their base prompts as assets; only the hunk overlay is
            // user data worth mirroring. Push hunks.json alone — nothing else.
            if (Object.keys(hunks).length === 0) {
                throw new Error('Disk sync for a built-in profile requires local patches.');
            }
            await writeFileText(dir, HUNKS_FILENAME, JSON.stringify(hunks, null, 2));
            return;
        }

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
            const row = await this.prompts.getProfilePrompt(type, profile.id);
            const content = row?.content ?? '';
            await writeFileText(dir, TYPE_FILENAME[type], content);
        }

        await writeFileText(dir, HUNKS_FILENAME, JSON.stringify(hunks, null, 2));
    }

    /** Files absent on disk leave their IDB row untouched — partial edit sets don't zero the rest. */
    async pullActiveFromDisk(): Promise<{ updatedTypes: number; metaUpdated: boolean }> {
        const profile = this.assertActiveProfile();
        const root = await this.folder.ensurePermission();
        const dir = await getDirIfExists(root, [profile.id]);
        if (!dir) {
            throw new Error(`Disk profile folder for '${profile.id}' does not exist yet — push first.`);
        }

        if (profile.isBuiltIn) {
            // Hunks-only: never overwrite a built-in's shipped base prompts. The
            // restored hunk-type count stands in for updatedTypes (base is 0).
            const restored = await this.pullHunks(dir, profile.id);
            await this.injection.forceReload();
            return { updatedTypes: restored, metaUpdated: false };
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
                    await this.profileMeta.put(meta);
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
            await this.prompts.saveProfilePrompt(type, profile.id, text);
            updatedTypes++;
        }

        await this.pullHunks(dir, profile.id);

        await this.injection.forceReload();
        return { updatedTypes, metaUpdated };
    }

    /**
     * `hunks.json` is the profile's whole patch set as one snapshot, so a present
     * file is authoritative: every type is reconciled to it, clearing types the
     * file omits. An absent file leaves IDB hunks untouched — matching the
     * per-type base-file rule that a partial export doesn't zero the rest.
     * Returns the count of types restored to a non-empty hunk set.
     */
    private async pullHunks(dir: FileSystemDirectoryHandle, profileId: string): Promise<number> {
        const text = await readFileText(dir, HUNKS_FILENAME);
        if (text === null) return 0;
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            console.warn('[DiskProfileSync] hunks.json parse failed; skipping hunk sync', err);
            return 0;
        }
        // A present-but-malformed file (hand-edited to `null`, an array, a scalar)
        // is treated like an unparseable one — skip rather than wipe IDB. An empty
        // object `{}` is still a valid snapshot that clears every type.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
        const byType = parsed as Record<string, unknown>;
        let restored = 0;
        for (const type of ALL_PROMPT_TYPES) {
            const hunks = byType[type];
            const arr = Array.isArray(hunks) ? hunks : [];
            await this.prompts.saveProfileHunks(type, profileId, arr);
            if (arr.length) restored++;
        }
        return restored;
    }

    private assertActiveProfile() {
        const id = this.state.activePromptProfile();
        const profile = this.registry.get(id);
        if (!profile) throw new Error(`Active profile '${id}' is not registered.`);
        return profile;
    }
}
