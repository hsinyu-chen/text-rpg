import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { INJECTION_FILE_PATHS } from '../constants/engine-protocol';
import { getLocale, getLangFolder } from '../constants/locales';
import { PromptRepository } from './storage/prompt.repository';
import { ProfileMetaRepository } from './storage/profile-meta.repository';
import { getProfileBasePath, getProfileScopedKey, DEFAULT_PROFILE_ID, PromptProfile } from '../constants/prompt-profiles';
import { PromptProfileRegistryService } from './prompt-profile-registry.service';
import { ActiveProfileStore } from './active-profile-store';
import { AppConfigStore } from './app-config-store';
import { KVStore } from './kv/kv-store';

export type PromptType = 'action' | 'continue' | 'fastforward' | 'system' | 'postprocess' | 'system_main' | 'protocol_single' | 'protocol_resolver' | 'protocol_narrator' | 'correction';

export const ALL_PROMPT_TYPES: readonly PromptType[] = [
    'action', 'continue', 'fastforward', 'system', 'system_main', 'postprocess', 'protocol_single', 'protocol_resolver', 'protocol_narrator', 'correction'
] as const;

// Optional types soft-load: missing asset returns '' instead of throwing,
// and there is no profile fallback (a missing local-profile file must NOT
// inherit from the default profile, since that would duplicate content with
// the local profile's still-inline copy).
const OPTIONAL_PROMPT_TYPES: ReadonlySet<PromptType> = new Set(['protocol_single', 'protocol_resolver', 'protocol_narrator', 'correction']);

@Injectable({
    providedIn: 'root'
})
export class InjectionService {
    private state = inject(GameStateService);
    private prompts = inject(PromptRepository);
    private profileMeta = inject(ProfileMetaRepository);
    private registry = inject(PromptProfileRegistryService);
    private activeProfileStore = inject(ActiveProfileStore);
    private appConfig = inject(AppConfigStore);
    private kv = inject(KVStore);
    private isSettingsLoading = false;

    private readonly ALL_TYPES = ALL_PROMPT_TYPES;

    private get profileId(): string {
        return this.state.activePromptProfile();
    }

    private normalizeLineEndings(str: string): string {
        return str.replace(/\r\n/g, '\n');
    }

    private hashString(str: string): string {
        let hash = 0;
        if (str.length === 0) return hash.toString();
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return hash.toString();
    }

    private lsKey(baseKey: string, overrideProfileId?: string): string {
        return getProfileScopedKey(baseKey, overrideProfileId ?? this.profileId);
    }

    applyPromptPlaceholders(template: string, lang = 'default'): string {
        const locale = getLocale(lang);
        const filenames = locale.coreFilenames;

        return template
            .replace(/\{\{FILE_BASIC_SETTINGS\}\}/g, filenames.BASIC_SETTINGS)
            .replace(/\{\{FILE_STORY_OUTLINE\}\}/g, filenames.STORY_OUTLINE)
            .replace(/\{\{FILE_CHARACTER_STATUS\}\}/g, filenames.CHARACTER_STATUS)
            .replace(/\{\{FILE_ASSETS\}\}/g, filenames.ASSETS)
            .replace(/\{\{FILE_TECH_EQUIPMENT\}\}/g, filenames.TECH_EQUIPMENT)
            .replace(/\{\{FILE_WORLD_FACTIONS\}\}/g, filenames.WORLD_FACTIONS)
            .replace(/\{\{FILE_MAGIC_SKILLS\}\}/g, filenames.MAGIC)
            .replace(/\{\{FILE_PLANS\}\}/g, filenames.PLANS)
            .replace(/\{\{FILE_INVENTORY\}\}/g, filenames.INVENTORY)
            .replace(/\{\{LANGUAGE_RULE\}\}/g, locale.promptHoles.LANGUAGE_RULE);
    }

    private async loadInjectionFile(path: string): Promise<string> {
        try {
            const response = await fetch(path, { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.text();
        } catch (err) {
            console.error(`[InjectionService] Failed to load injection file: ${path}`, err);
            throw new Error(`Failed to load system file: ${path}`);
        }
    }

    /** Built-in only — user profiles are IDB-only and have no shipped assets. */
    private async loadBuiltInAsset(langFolder: string, filename: string, targetProfileId: string): Promise<string> {
        const profileBase = getProfileBasePath(langFolder, targetProfileId);
        const profilePath = `${profileBase}/${filename}`;

        try {
            return await this.loadInjectionFile(profilePath);
        } catch {
            if (targetProfileId !== DEFAULT_PROFILE_ID) {
                const fallbackBase = getProfileBasePath(langFolder, DEFAULT_PROFILE_ID);
                const fallbackPath = `${fallbackBase}/${filename}`;
                console.log(`[InjectionService] Falling back to default profile for ${filename}`);
                return this.loadInjectionFile(fallbackPath);
            }
            throw new Error(`Failed to load system file: ${profilePath}`);
        }
    }

    /** Soft load — returns '' when the file is absent, no profile fallback. */
    private async loadOptionalProfileAsset(langFolder: string, filename: string, targetProfileId: string): Promise<string> {
        const profilePath = `${getProfileBasePath(langFolder, targetProfileId)}/${filename}`;
        try {
            return await this.loadInjectionFile(profilePath);
        } catch {
            return '';
        }
    }

    private async loadUserProfilePrompt(type: PromptType, profileId: string, langFolder: string, lang: string): Promise<string> {
        const visited = new Set<string>();
        let current: PromptProfile | undefined = this.registry.get(profileId);
        while (current && !visited.has(current.id)) {
            visited.add(current.id);

            // Built-ins are immutable — always re-fetch from the shipped disk
            // asset (which also refreshes the IDB cache) so changes to a
            // shipped prompt propagate without requiring users to manually accept
            // the prompt-update badge.
            if (current.isBuiltIn) {
                const seeded = await this.seedBuiltInAssetToIdb(type, langFolder, lang, current.id);
                if (seeded !== null) return seeded;
                // disk fetch failed — fall back to the (possibly stale) IDB row
                const row = await this.prompts.getProfilePrompt(type, current.id);
                if (row?.content !== undefined) return row.content;
            } else {
                const row = await this.prompts.getProfilePrompt(type, current.id);
                if (row?.content !== undefined) return row.content;
            }

            if (!current.baseProfileId) break;
            current = this.registry.get(current.baseProfileId);
        }
        const cloudRow = await this.prompts.getProfilePrompt(type, DEFAULT_PROFILE_ID);
        return cloudRow?.content ?? '';
    }

    /** Returns null on fetch failure so callers can fall through to their next strategy. */
    private async seedBuiltInAssetToIdb(type: PromptType, langFolder: string, lang: string, profileId: string): Promise<string | null> {
        try {
            const filename = INJECTION_FILE_PATHS[type];
            const raw = OPTIONAL_PROMPT_TYPES.has(type)
                ? await this.loadOptionalProfileAsset(langFolder, filename, profileId)
                : await this.loadBuiltInAsset(langFolder, filename, profileId);
            const processed = type === 'postprocess' ? raw : this.applyPromptPlaceholders(raw, lang);
            // Skip the IDB write when content matches — without this guard,
            // every read-side caller (compat checks, profile listing) would
            // perform a write on every invocation.
            const existing = await this.prompts.getProfilePrompt(type, profileId);
            if (!existing || existing.content !== processed) {
                await this.prompts.saveProfilePrompt(type, profileId, processed);
            }
            return processed;
        } catch (err) {
            console.warn(`[InjectionService] seedBuiltInAssetToIdb: failed for ${type} on '${profileId}'`, err);
            return null;
        }
    }

    markAsModified(type: PromptType): void {
        this.kv.set(this.lsKey(`prompt_user_modified_${type}`), 'true');
    }

    /** Throws on built-in profiles — UI must clone first. */
    async saveToService(type: PromptType, content: string): Promise<void> {
        const profile = this.registry.get(this.profileId);
        if (profile?.isBuiltIn) {
            throw new Error('Cannot save to a built-in profile. Clone it first.');
        }
        await this.prompts.saveProfilePrompt(type, this.profileId, content);
        this.markAsModified(type);

        this.setSignalContent(type, content);
    }

    /** No-op for user profiles — they never have a server hash to compare against. */
    async acknowledgeUpdate(type: PromptType, applyUpdate: boolean): Promise<void> {
        const profile = this.registry.get(this.profileId);
        if (profile && !profile.isBuiltIn) return;

        const status = this.state.promptUpdateStatus().get(type);
        if (!status) return;

        if (applyUpdate) {
            this.setSignalContent(type, status.serverContent);
            this.kv.set(this.lsKey(`prompt_user_modified_${type}`), 'false');
            await this.prompts.saveProfilePrompt(type, this.profileId, status.serverContent);
        }

        const newHash = this.hashString(this.normalizeLineEndings(status.serverContent));
        this.kv.set(this.lsKey(`prompt_last_server_hash_${type}`), newHash);

        this.state.promptUpdateStatus.update(map => {
            const newMap = new Map(map);
            newMap.set(type, { ...status, hasUpdate: false });
            return newMap;
        });
    }

    async loadDynamicInjectionSettings() {
        if (this.isSettingsLoading) return;
        this.isSettingsLoading = true;

        try {
            const lang = this.appConfig.outputLanguage();
            const langFolder = getLangFolder(lang);
            const currentProfile = this.profileId;
            const profile = this.registry.get(currentProfile);
            const isBuiltIn = profile?.isBuiltIn ?? false;

            if (isBuiltIn) {
                await this.loadBuiltInProfile(currentProfile, langFolder, lang);
            } else {
                await this.loadUserProfile(currentProfile, langFolder, lang);
            }

            this.state.injectionSettingsLoaded.set(true);
            console.log(`[InjectionService] Settings loaded for profile: ${currentProfile}`);
        } catch (globalErr: unknown) {
            console.error('[InjectionService] Global error in loader', globalErr);
            this.state.status.set('error');
            const msg = globalErr instanceof Error ? globalErr.message : String(globalErr);
            this.state.criticalError.set(msg || 'Unknown system error');
        } finally {
            this.isSettingsLoading = false;
        }
    }

    private async loadBuiltInProfile(currentProfile: string, langFolder: string, lang: string): Promise<void> {
        const loadPath = (filename: string) => this.loadBuiltInAsset(langFolder, filename, currentProfile);
        const loadOptional = (filename: string) => this.loadOptionalProfileAsset(langFolder, filename, currentProfile);

        let actionDef, continueDef, fastforwardDef, systemDef, systemMainDef, postprocessDef, protocolSingleDef, protocolResolverDef, protocolNarratorDef;
        try {
            [actionDef, continueDef, fastforwardDef, systemDef, systemMainDef, postprocessDef, protocolSingleDef, protocolResolverDef, protocolNarratorDef] =
                await Promise.all([
                    loadPath(INJECTION_FILE_PATHS.action),
                    loadPath(INJECTION_FILE_PATHS.continue),
                    loadPath(INJECTION_FILE_PATHS.fastforward),
                    loadPath(INJECTION_FILE_PATHS.system),
                    loadPath(INJECTION_FILE_PATHS.system_main),
                    loadPath(INJECTION_FILE_PATHS.postprocess),
                    loadOptional(INJECTION_FILE_PATHS.protocol_single),
                    loadOptional(INJECTION_FILE_PATHS.protocol_resolver),
                    loadOptional(INJECTION_FILE_PATHS.protocol_narrator)
                ]);
        } catch (err: unknown) {
            console.error('[InjectionService] Critical Error loading prompts', err);
            this.state.status.set('error');
            const msg = err instanceof Error ? err.message : String(err);
            this.state.criticalError.set(msg || 'Failed to load essential system files.');
            return;
        }

        const types = [
            { id: 'action', content: actionDef, legacyKey: 'dynamic_action_injection', isPost: false },
            { id: 'continue', content: continueDef, legacyKey: 'dynamic_continue_injection', isPost: false },
            { id: 'fastforward', content: fastforwardDef, legacyKey: 'dynamic_fastforward_injection', isPost: false },
            { id: 'system', content: systemDef, legacyKey: 'dynamic_system_injection', isPost: false },
            { id: 'system_main', content: systemMainDef, legacyKey: '', isPost: false },
            { id: 'postprocess', content: postprocessDef, legacyKey: 'post_process_script', isPost: true },
            { id: 'protocol_single', content: protocolSingleDef, legacyKey: '', isPost: false },
            { id: 'protocol_resolver', content: protocolResolverDef, legacyKey: '', isPost: false },
            { id: 'protocol_narrator', content: protocolNarratorDef, legacyKey: '', isPost: false }
        ] as const;

        const updateStatusMap = new Map<string, { hasUpdate: boolean, serverContent: string }>();

        for (const type of types) {
            const processedServerContent = type.isPost ? type.content : this.applyPromptPlaceholders(type.content, lang);
            const serverHash = this.hashString(this.normalizeLineEndings(processedServerContent));
            const hashKey = this.lsKey(`prompt_last_server_hash_${type.id}`, currentProfile);
            const modifiedKey = this.lsKey(`prompt_user_modified_${type.id}`, currentProfile);
            const lastServerHash = this.kv.get(hashKey);
            const isModified = this.kv.get(modifiedKey) === 'true';

            let hasUpdate = false;

            if (lastServerHash === null) {
                this.kv.set(hashKey, serverHash);
            } else if (serverHash !== lastServerHash) {
                if (isModified) {
                    hasUpdate = true;
                } else {
                    this.kv.set(hashKey, serverHash);
                }
            }

            updateStatusMap.set(type.id, { hasUpdate, serverContent: processedServerContent });

            let dbRecord = await this.prompts.getProfilePrompt(type.id, currentProfile);

            // Pre-IDB customizations were stored in raw localStorage; migrate on read.
            // Talks to localStorage directly, matching MigrationService.purgeLegacyLocalStorageKeys —
            // these keys pre-date KVStore, and if KVStore's backend ever moves off localStorage
            // the read must still hit the raw global or the migration silently misses old user data.
            if (!dbRecord && type.legacyKey && currentProfile === DEFAULT_PROFILE_ID) {
                // eslint-disable-next-line no-restricted-globals -- see comment above
                const legacyContent = localStorage.getItem(type.legacyKey);
                if (legacyContent) {
                    console.log(`[InjectionService] Migrating ${type.id} from localStorage to IndexedDB`);
                    await this.prompts.saveProfilePrompt(type.id, currentProfile, legacyContent);
                    dbRecord = { content: legacyContent, lastModified: Date.now() };
                    // eslint-disable-next-line no-restricted-globals
                    localStorage.removeItem(type.legacyKey);
                }
            }

            // `content !== undefined`, not truthiness — empty string is a valid customization.
            if (isModified && dbRecord?.content !== undefined) {
                this.setSignalContent(type.id as PromptType, dbRecord.content);
            } else {
                this.setSignalContent(type.id as PromptType, processedServerContent);
                this.kv.set(modifiedKey, 'false');

                // Seed default into IDB so a future clone has something to copy,
                // AND re-write when an unmodified built-in's disk content has
                // changed (otherwise non-active reads via getResolvedProfilePrompt
                // surface stale content — which broke per-profile compat checks
                // after the @system-main-version marker was added).
                if (!dbRecord || dbRecord.content !== processedServerContent) {
                    await this.prompts.saveProfilePrompt(type.id, currentProfile, processedServerContent);
                }
            }
        }

        this.state.promptUpdateStatus.set(updateStatusMap);
    }

    private async loadUserProfile(currentProfile: string, langFolder: string, lang: string): Promise<void> {
        const updateStatusMap = new Map<string, { hasUpdate: boolean, serverContent: string }>();
        for (const type of this.ALL_TYPES) {
            const content = await this.loadUserProfilePrompt(type, currentProfile, langFolder, lang);
            this.setSignalContent(type, content);
            // serverContent gets the resolved IDB content; user profiles never raise the badge.
            updateStatusMap.set(type, { hasUpdate: false, serverContent: content });
        }
        this.state.promptUpdateStatus.set(updateStatusMap);
    }

    private setSignalContent(type: PromptType, content: string) {
        switch (type) {
            case 'action': this.state.dynamicActionInjection.set(content); break;
            case 'continue': this.state.dynamicContinueInjection.set(content); break;
            case 'fastforward': this.state.dynamicFastforwardInjection.set(content); break;
            case 'system': this.state.dynamicSystemInjection.set(content); break;
            case 'system_main': this.state.dynamicSystemMainInjection.set(content); break;
            case 'postprocess': this.state.postProcessScript.set(content); break;
            case 'protocol_single': this.state.dynamicProtocolSingleInjection.set(content); break;
            case 'protocol_resolver': this.state.dynamicProtocolResolverInjection.set(content); break;
            case 'protocol_narrator': this.state.dynamicProtocolNarratorInjection.set(content); break;
            case 'correction': this.state.dynamicCorrectionInjection.set(content); break;
        }
    }

    async switchProfile(newProfileId: string): Promise<void> {
        const profile = this.registry.get(newProfileId);
        if (!profile) {
            console.error(`[InjectionService] Unknown profile: ${newProfileId}`);
            return;
        }

        const oldProfileId = this.profileId;
        if (oldProfileId === newProfileId) return;

        console.log(`[InjectionService] Switching profile: ${oldProfileId} → ${newProfileId}`);

        this.activeProfileStore.set(newProfileId);

        await this.forceReload();
    }

    /** Resets both load guards so the loader re-reads IDB even if a previous load is mid-flight or marked done. */
    async forceReload(): Promise<void> {
        this.isSettingsLoading = false;
        this.state.injectionSettingsLoaded.set(false);
        await this.loadDynamicInjectionSettings();
    }

    /** Returns the new user profile id. */
    async cloneProfile(sourceId: string, displayName: string): Promise<string> {
        const source = this.registry.get(sourceId);
        if (!source) throw new Error(`Unknown profile: ${sourceId}`);

        const newId = PromptProfileRegistryService.generateId();
        const now = Date.now();

        const lang = this.appConfig.outputLanguage();
        const langFolder = getLangFolder(lang);

        for (const type of this.ALL_TYPES) {
            let row = await this.prompts.getProfilePrompt(type, sourceId);

            // Non-active built-ins haven't been seeded to IDB; pull the asset on demand.
            if (!row && source.isBuiltIn) {
                const seeded = await this.seedBuiltInAssetToIdb(type, langFolder, lang, sourceId);
                if (seeded !== null) row = { content: seeded, lastModified: Date.now() };
            }

            if (row) {
                await this.prompts.saveProfilePrompt(type, newId, row.content, row.tokens);
            }
        }

        // Inherit the source's modified-vs-default state at clone time; the new profile diverges from there.
        for (const type of this.ALL_TYPES) {
            for (const baseKey of [`prompt_user_modified_${type}`, `prompt_last_server_hash_${type}`]) {
                const sourceLsKey = getProfileScopedKey(baseKey, sourceId);
                const newLsKey = getProfileScopedKey(baseKey, newId);
                const value = this.kv.get(sourceLsKey);
                if (value !== null) this.kv.set(newLsKey, value);
            }
        }

        const meta = {
            id: newId,
            displayName,
            baseProfileId: sourceId,
            createdAt: now,
            updatedAt: now
        };
        await this.profileMeta.put(meta);
        this.registry.add({
            id: newId,
            isBuiltIn: false,
            subDir: null,
            displayName,
            baseProfileId: sourceId,
            createdAt: now,
            updatedAt: now
        });

        return newId;
    }

    async renameProfile(id: string, displayName: string): Promise<void> {
        const profile = this.registry.get(id);
        if (!profile) throw new Error(`Unknown profile: ${id}`);
        if (profile.isBuiltIn) throw new Error('Cannot rename a built-in profile');

        const meta = await this.profileMeta.get(id);
        if (!meta) throw new Error(`Missing meta for profile: ${id}`);
        const updated = { ...meta, displayName, updatedAt: Date.now() };
        await this.profileMeta.put(updated);
        this.registry.update(id, { displayName, updatedAt: updated.updatedAt });
    }

    /** Caller must switch off the active profile before calling this if `id` is currently active. */
    async deleteProfile(id: string): Promise<void> {
        const profile = this.registry.get(id);
        if (!profile) return;
        if (profile.isBuiltIn) throw new Error('Cannot delete a built-in profile');

        await this.prompts.deleteAllForProfile(id);
        for (const type of this.ALL_TYPES) {
            for (const baseKey of [`prompt_user_modified_${type}`, `prompt_last_server_hash_${type}`]) {
                this.kv.remove(getProfileScopedKey(baseKey, id));
            }
        }
        await this.profileMeta.delete(id);
        this.registry.remove(id);
    }

    /**
     * Resolves the prompt content for a SPECIFIC profile without disturbing
     * the active state — intended for the profile selector UI to compute
     * per-profile compatibility badges. Walks the same chain as the active
     * loader (custom IDB row → base built-in via seed-on-demand).
     */
    async getResolvedProfilePrompt(type: PromptType, profileId: string): Promise<string> {
        const lang = this.appConfig.outputLanguage();
        const langFolder = getLangFolder(lang);
        return this.loadUserProfilePrompt(type, profileId, langFolder, lang);
    }

    getContentForType(type: PromptType): string {
        switch (type) {
            case 'action': return this.state.dynamicActionInjection();
            case 'continue': return this.state.dynamicContinueInjection();
            case 'fastforward': return this.state.dynamicFastforwardInjection();
            case 'system': return this.state.dynamicSystemInjection();
            case 'system_main': return this.state.dynamicSystemMainInjection();
            case 'postprocess': return this.state.postProcessScript();
            case 'protocol_single': return this.state.dynamicProtocolSingleInjection();
            case 'protocol_resolver': return this.state.dynamicProtocolResolverInjection();
            case 'protocol_narrator': return this.state.dynamicProtocolNarratorInjection();
            case 'correction': return this.state.dynamicCorrectionInjection();
        }
    }
}
