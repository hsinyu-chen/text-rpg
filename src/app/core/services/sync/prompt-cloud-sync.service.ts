import { Injectable, inject } from '@angular/core';
import { PromptRepository } from '../storage/prompt.repository';
import { ProfileMetaRepository } from '../storage/profile-meta.repository';
import { PromptProfileRegistryService } from '../prompt-profile-registry.service';
import { ALL_PROMPT_TYPES, type PromptType } from '../injection.service';
import { BUILT_IN_PROFILES, getProfileScopedKey, USER_PROFILE_ID_PREFIX } from '@app/core/constants/prompt-profiles';
import { KVStore } from '../kv/kv-store';
import { SyncBackend } from './sync.types';

const PROMPT_TYPES = ALL_PROMPT_TYPES;

/**
 * v2 export schema — explicit `version` discriminator separates v2 from the
 * legacy v1 shape (which was a flat `Record<key, value>` with no envelope).
 * v2 carries user-profile metadata so receiving devices can rebuild the
 * profile registry; v1 only had the prompts themselves and treated user
 * profile rows as orphans.
 */
interface PromptsV2 {
    version: 2;
    profiles: {
        id: string;
        displayName: string;
        baseProfileId: string;
        createdAt: number;
        updatedAt: number;
    }[];
    prompts: Record<string, { content: string; tokens?: number }>;
}

function isPromptsV2(x: unknown): x is PromptsV2 {
    if (!x || typeof x !== 'object') return false;
    const obj = x as Partial<PromptsV2>;
    return obj.version === 2
        && Array.isArray(obj.profiles)
        && typeof obj.prompts === 'object'
        && obj.prompts !== null;
}

function importSuffix(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    }
    return Math.random().toString(36).slice(2, 10);
}

function isValidUserProfileId(id: unknown): id is string {
    // Untrimmed regex — id is used as an IDB key verbatim, whitespace must fail outright.
    return typeof id === 'string'
        && id.startsWith(USER_PROFILE_ID_PREFIX)
        && /^[A-Za-z0-9_-]{3,}$/.test(id);
}

/**
 * Cloud transport for prompt profiles + their per-type prompt rows.
 * Lives separately from the main `SyncService` because the lifecycle is
 * fundamentally different — prompts are app-global (one shared cloud blob),
 * not a per-book reconciled stream — and the v1↔v2 schema handling adds
 * substantial surface that doesn't share state with book/collection sync.
 *
 * Backend resolution is delegated via the constructor-supplied callback
 * so this service stays clear of the sync state machine.
 */
@Injectable({ providedIn: 'root' })
export class PromptCloudSyncService {
    private prompts = inject(PromptRepository);
    private profileMeta = inject(ProfileMetaRepository);
    private profileRegistry = inject(PromptProfileRegistryService);
    private kv = inject(KVStore);

    private backendResolver: (() => Promise<SyncBackend>) | null = null;

    /**
     * Wire the backend resolver. Called by SyncService at construction so
     * this service can reach the active backend without injecting SyncService
     * (would form a circular dep).
     */
    registerBackendResolver(resolver: () => Promise<SyncBackend>): void {
        this.backendResolver = resolver;
    }

    private async getBackend(): Promise<SyncBackend> {
        if (!this.backendResolver) {
            throw new Error('PromptCloudSyncService: backend resolver not registered.');
        }
        const backend = await this.backendResolver();
        await backend.authenticate();
        return backend;
    }

    /**
     * Collect a profile's per-type prompt rows into the v2 payload shape.
     * `onlyUserModified=true` (built-in profiles in `uploadPrompts`): skip
     * rows whose `prompt_user_modified_<type>` flag isn't set, since
     * receivers already have the same shipped asset. User profiles and
     * `exportSingleProfile` always ship everything they've got.
     */
    private async collectProfilePrompts(
        profileId: string,
        opts: { onlyUserModified: boolean }
    ): Promise<Record<string, { content: string; tokens?: number }>> {
        // Parallel: prompts.getProfilePrompt is a local IDB read with no
        // remote rate limit, and the per-type fetches are independent.
        const results = await Promise.all(PROMPT_TYPES.map(async type => {
            if (opts.onlyUserModified) {
                const flagKey = getProfileScopedKey(`prompt_user_modified_${type}`, profileId);
                if (this.kv.get(flagKey) !== 'true') return null;
            }
            const rec = await this.prompts.getProfilePrompt(type, profileId);
            return rec ? { type, rec } : null;
        }));

        const out: Record<string, { content: string; tokens?: number }> = {};
        for (const res of results) {
            if (res) out[`${profileId}:${res.type}`] = { content: res.rec.content, tokens: res.rec.tokens };
        }
        return out;
    }

    /**
     * Built-ins ship only their user-modified rows. User profiles ship in
     * full — receiving device has no shipped asset to fall back on.
     */
    async uploadPrompts(): Promise<{ exported: number }> {
        const backend = await this.getBackend();

        // Profiles collected in parallel — each profile's collectProfilePrompts
        // already parallelizes its own per-type reads, so this fans out
        // (profiles × types) independent IDB reads. Profile metadata
        // assembly happens in the resolved-results loop where ordering
        // doesn't matter.
        const profileResults = await Promise.all(
            this.profileRegistry.list().map(async profile => ({
                profile,
                profilePrompts: await this.collectProfilePrompts(profile.id, { onlyUserModified: profile.isBuiltIn })
            }))
        );

        const prompts: Record<string, { content: string; tokens?: number }> = {};
        const profilesOut: PromptsV2['profiles'] = [];
        for (const { profile, profilePrompts } of profileResults) {
            if (!profile.isBuiltIn) {
                profilesOut.push({
                    id: profile.id,
                    displayName: profile.displayName ?? profile.id,
                    baseProfileId: profile.baseProfileId ?? 'cloud',
                    createdAt: profile.createdAt ?? Date.now(),
                    updatedAt: profile.updatedAt ?? Date.now()
                });
            }
            Object.assign(prompts, profilePrompts);
        }

        const payload: PromptsV2 = { version: 2, profiles: profilesOut, prompts };
        await backend.writePrompts(JSON.stringify(payload));
        return { exported: Object.keys(prompts).length };
    }

    /** v1 payloads have no profile metadata, so user-prefixed entries in v1 are dropped as orphans. */
    async downloadPrompts(): Promise<{ imported: number }> {
        const backend = await this.getBackend();
        const json = await backend.readPrompts();
        if (!json) return { imported: 0 };

        const parsed = JSON.parse(json) as Partial<PromptsV2> | Record<string, { content: string; tokens?: number }>;
        if (isPromptsV2(parsed)) {
            return this.applyPromptsV2(parsed);
        }
        return this.applyPromptsV1Legacy(parsed as Record<string, { content: string; tokens?: number }>);
    }

    async exportSingleProfile(profileId: string): Promise<string> {
        const profile = this.profileRegistry.get(profileId);
        if (!profile) throw new Error(`Unknown profile: ${profileId}`);

        // Built-in profiles preserve original behavior here: ship every row
        // we've got, not just user-modified ones. Diverges from uploadPrompts
        // because the user explicitly clicked Export on this specific profile,
        // so they want a complete dump rather than a diff against the shipped
        // baseline.
        const prompts = await this.collectProfilePrompts(profileId, { onlyUserModified: false });

        const profilesOut: PromptsV2['profiles'] = profile.isBuiltIn ? [] : [{
            id: profile.id,
            displayName: profile.displayName ?? profile.id,
            baseProfileId: profile.baseProfileId ?? 'cloud',
            createdAt: profile.createdAt ?? Date.now(),
            updatedAt: profile.updatedAt ?? Date.now()
        }];

        const payload: PromptsV2 = { version: 2, profiles: profilesOut, prompts };
        return JSON.stringify(payload, null, 2);
    }

    async importSingleProfile(json: string): Promise<{ imported: number }> {
        const parsed = JSON.parse(json) as unknown;
        if (!isPromptsV2(parsed)) throw new Error('Not a v2 prompt profile export');
        return this.applyPromptsV2(parsed);
    }

    private async applyPromptsV2(payload: PromptsV2): Promise<{ imported: number }> {
        const idRemap = new Map<string, string>();
        // Tracks every id we've assigned in this batch (existing registry +
        // newly-minted suffix variants) so two incoming collisions can't both
        // generate the same fresh id within a single import.
        const assignedIds = new Set<string>(this.profileRegistry.list().map(p => p.id));
        for (const incoming of payload.profiles ?? []) {
            if (!isValidUserProfileId(incoming.id)) {
                console.warn('[PromptCloudSync] applyPromptsV2: dropping profile with invalid id', incoming);
                continue;
            }

            // Hand-edited / partial exports can carry undefined fields; meta store requires them populated.
            const incomingName = incoming.displayName || incoming.id;
            const incomingBase = incoming.baseProfileId || 'cloud';
            const incomingCreatedAt = incoming.createdAt ?? Date.now();
            const incomingUpdatedAt = incoming.updatedAt ?? incomingCreatedAt;

            const existing = this.profileRegistry.get(incoming.id);
            const collidesDifferent = existing && !existing.isBuiltIn &&
                (existing.displayName !== incomingName || existing.baseProfileId !== incomingBase);

            // Loop the suffix lottery until unused — guards against a future
            // weakening of importSuffix() AND against intra-batch collisions
            // between two incoming profiles that happen to draw the same suffix.
            let targetId = incoming.id;
            if (collidesDifferent) {
                do {
                    targetId = `${incoming.id}_imported_${importSuffix()}`;
                } while (assignedIds.has(targetId));
            }
            assignedIds.add(targetId);
            if (targetId !== incoming.id) idRemap.set(incoming.id, targetId);

            const meta = {
                id: targetId,
                displayName: incomingName,
                baseProfileId: incomingBase,
                createdAt: incomingCreatedAt,
                updatedAt: incomingUpdatedAt
            };
            await this.profileMeta.put(meta);
            const existingTarget = this.profileRegistry.get(targetId);
            if (existingTarget) {
                this.profileRegistry.update(targetId, { displayName: incomingName, baseProfileId: incomingBase, updatedAt: incomingUpdatedAt });
            } else {
                this.profileRegistry.add({
                    id: targetId,
                    isBuiltIn: false,
                    subDir: null,
                    displayName: incomingName,
                    baseProfileId: incomingBase,
                    createdAt: incomingCreatedAt,
                    updatedAt: incomingUpdatedAt
                });
            }
        }

        // Parallel: per-row IDB writes are independent. Counts come from
        // filtering the resolved promises rather than mutating a closure
        // counter — avoids subtle race assumptions even though JS is
        // single-threaded.
        const v2Results = await Promise.all(Object.entries(payload.prompts ?? {}).map(async ([key, value]) => {
            if (!value || typeof value.content !== 'string') return false;
            const colon = key.indexOf(':');
            if (colon <= 0) return false;
            const incomingId = key.slice(0, colon);
            const type = key.slice(colon + 1);
            if (!PROMPT_TYPES.includes(type as PromptType)) return false;

            const profileId = idRemap.get(incomingId) ?? incomingId;
            const profile = this.profileRegistry.get(profileId);
            // Drop rows whose profile entry never made it into the registry (orphan).
            if (!profile) return false;

            await this.prompts.saveProfilePrompt(type, profileId, value.content, value.tokens);
            if (profile.isBuiltIn) {
                this.kv.set(getProfileScopedKey(`prompt_user_modified_${type}`, profileId), 'true');
            }
            return true;
        }));
        return { imported: v2Results.filter(Boolean).length };
    }

    private async applyPromptsV1Legacy(parsed: Record<string, { content: string; tokens?: number }>): Promise<{ imported: number }> {
        const results = await Promise.all(Object.entries(parsed).map(async ([key, value]) => {
            if (!value || typeof value.content !== 'string') return false;
            const colon = key.indexOf(':');
            if (colon <= 0) return false;
            const profileId = key.slice(0, colon);
            const type = key.slice(colon + 1);
            if (!BUILT_IN_PROFILES.some(p => p.id === profileId)) return false;
            if (!PROMPT_TYPES.includes(type as PromptType)) return false;
            await this.prompts.saveProfilePrompt(type, profileId, value.content, value.tokens);
            this.kv.set(getProfileScopedKey(`prompt_user_modified_${type}`, profileId), 'true');
            return true;
        }));
        return { imported: results.filter(Boolean).length };
    }
}
