import { Injectable, inject } from '@angular/core';
import { PromptRepository } from '../storage/prompt.repository';
import { ProfileMetaRepository } from '../storage/profile-meta.repository';
import { PromptProfileRegistryService } from '../prompt-profile-registry.service';
import { ALL_PROMPT_TYPES, type PromptType } from '../injection.service';
import { BUILT_IN_PROFILES, getProfileScopedKey, PromptProfile, USER_PROFILE_ID_PREFIX } from '@app/core/constants/prompt-profiles';
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
    /**
     * Local hunk patches, keyed `${profileId}:${type}` like `prompts`. Optional
     * and additive — pre-hunk exports omit it and a reader predating this field
     * ignores it, so it rides inside v2 with no version bump.
     */
    hunks?: Record<string, unknown[]>;
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
     * A profile's hunk overlays, keyed `${profileId}:${type}` to merge into the
     * flat payload map. Always shipped — even for built-ins, and regardless of
     * the user-modified flag: a hunk is user data with no shipped baseline to
     * diff against, so there's nothing to skip.
     */
    private async collectProfileHunks(profileId: string): Promise<Record<string, unknown[]>> {
        const byType = await this.prompts.getAllProfileHunks(profileId, PROMPT_TYPES);
        const out: Record<string, unknown[]> = {};
        for (const [type, hunks] of Object.entries(byType)) {
            out[`${profileId}:${type}`] = hunks;
        }
        return out;
    }

    /** Map a registry profile to its v2 export metadata row. */
    private toProfileMeta(profile: PromptProfile): PromptsV2['profiles'][number] {
        return {
            id: profile.id,
            displayName: profile.displayName ?? profile.id,
            baseProfileId: profile.baseProfileId ?? 'cloud',
            createdAt: profile.createdAt ?? Date.now(),
            updatedAt: profile.updatedAt ?? Date.now()
        };
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
                profilePrompts: await this.collectProfilePrompts(profile.id, { onlyUserModified: profile.isBuiltIn }),
                profileHunks: await this.collectProfileHunks(profile.id)
            }))
        );

        const prompts: Record<string, { content: string; tokens?: number }> = {};
        const hunks: Record<string, unknown[]> = {};
        const profilesOut: PromptsV2['profiles'] = [];
        for (const { profile, profilePrompts, profileHunks } of profileResults) {
            if (!profile.isBuiltIn) {
                profilesOut.push(this.toProfileMeta(profile));
            }
            Object.assign(prompts, profilePrompts);
            Object.assign(hunks, profileHunks);
        }

        // Always emit `hunks` (even {}): on download an absent field means a
        // pre-feature payload (don't clear), whereas {} means "synced, now empty"
        // and must clear. Omitting it would make a full deletion un-syncable.
        const payload: PromptsV2 = { version: 2, profiles: profilesOut, prompts, hunks };
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
            // Download mirrors the cloud onto this device, so omitted hunks clear.
            return this.applyPromptsV2(parsed, true);
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
        const hunks = await this.collectProfileHunks(profileId);

        const profilesOut: PromptsV2['profiles'] = profile.isBuiltIn ? [] : [this.toProfileMeta(profile)];

        const payload: PromptsV2 = { version: 2, profiles: profilesOut, prompts, hunks };
        return JSON.stringify(payload, null, 2);
    }

    async importSingleProfile(json: string): Promise<{ imported: number }> {
        const parsed = JSON.parse(json) as unknown;
        if (!isPromptsV2(parsed)) throw new Error('Not a v2 prompt profile export');
        // Import merges one profile — it must not clear hunks on the others.
        return this.applyPromptsV2(parsed, false);
    }

    /**
     * Resolve a `${profileId}:${type}` payload key to its target row: split the
     * id/type, validate the type, apply the import id-remap, and confirm the
     * profile registered. Returns null for a malformed key, unknown type, or
     * orphan profile — shared by the prompt-row and hunk apply loops.
     */
    private resolvePayloadKey(
        key: string,
        idRemap: Map<string, string>,
    ): { type: PromptType; profileId: string; profile: PromptProfile } | null {
        const colon = key.indexOf(':');
        if (colon <= 0) return null;
        const type = key.slice(colon + 1);
        if (!PROMPT_TYPES.includes(type as PromptType)) return null;
        const profileId = idRemap.get(key.slice(0, colon)) ?? key.slice(0, colon);
        const profile = this.profileRegistry.get(profileId);
        if (!profile) return null;
        return { type: type as PromptType, profileId, profile };
    }

    private async applyPromptsV2(payload: PromptsV2, clearOmittedHunks: boolean): Promise<{ imported: number }> {
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
            const resolved = this.resolvePayloadKey(key, idRemap);
            if (!resolved) return false;
            const { type, profileId, profile } = resolved;

            await this.prompts.saveProfilePrompt(type, profileId, value.content, value.tokens);
            if (profile.isBuiltIn) {
                this.kv.set(getProfileScopedKey(`prompt_user_modified_${type}`, profileId), 'true');
            }
            return true;
        }));

        await this.applyHunks(payload.hunks, idRemap, payload.profiles, clearOmittedHunks);
        return { imported: v2Results.filter(Boolean).length };
    }

    /**
     * Apply imported hunk overlays under the same id-remap as prompt rows.
     * Orphan rows (profile never registered) are dropped. Not tallied into
     * `imported`, which counts base-prompt rows only.
     *
     * `clearOmitted` (cloud download) first wipes every synced profile's hunks so
     * the device mirrors the payload exactly — a hunk deleted elsewhere, and thus
     * absent here, is cleared rather than left behind. Single-profile import
     * passes false: it merges one profile and must not touch the others. An
     * undefined `hunks` is a pre-feature payload — never clear on that.
     */
    private async applyHunks(
        hunks: PromptsV2['hunks'],
        idRemap: Map<string, string>,
        profiles: PromptsV2['profiles'],
        clearOmitted: boolean,
    ): Promise<void> {
        // undefined = pre-feature payload; null / array / scalar = malformed (e.g.
        // hand-edited). Either way, skip rather than crash on Object.entries or
        // wipe local hunks via an empty clear.
        if (!hunks || typeof hunks !== 'object' || Array.isArray(hunks)) return;

        const incoming: { type: PromptType; profileId: string; value: unknown[] }[] = [];
        for (const [key, value] of Object.entries(hunks)) {
            if (!Array.isArray(value)) continue;
            const resolved = this.resolvePayloadKey(key, idRemap);
            if (resolved) incoming.push({ type: resolved.type, profileId: resolved.profileId, value });
        }

        if (clearOmitted) {
            // Types the payload re-writes below are skipped here — clearing then
            // immediately overwriting them would be a redundant IDB write.
            const incomingKeys = new Set(incoming.map((h) => `${h.profileId}:${h.type}`));
            const syncedIds = new Set<string>(BUILT_IN_PROFILES.map((p) => p.id));
            for (const p of profiles ?? []) syncedIds.add(idRemap.get(p.id) ?? p.id);
            await Promise.all([...syncedIds].map((profileId) =>
                Promise.all(PROMPT_TYPES.map(async (type) => {
                    if (incomingKeys.has(`${profileId}:${type}`)) return;
                    // Skip the no-op [] write when the type is already empty.
                    if ((await this.prompts.getProfileHunks(type, profileId)).length > 0) {
                        await this.prompts.saveProfileHunks(type, profileId, []);
                    }
                })),
            ));
        }

        await Promise.all(incoming.map(({ type, profileId, value }) =>
            this.prompts.saveProfileHunks(type, profileId, value),
        ));
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
