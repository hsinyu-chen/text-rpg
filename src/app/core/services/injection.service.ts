import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { INJECTION_FILE_PATHS } from '../constants/engine-protocol';
import { getLocale, getLangFolder } from '../constants/locales';
import { StorageService } from './storage.service';
import { getProfileBasePath, getProfileScopedKey, DEFAULT_PROFILE_ID, PromptProfile } from '../constants/prompt-profiles';
import { PromptProfileRegistryService } from './prompt-profile-registry.service';

export type PromptType = 'action' | 'continue' | 'fastforward' | 'system' | 'save' | 'postprocess' | 'system_main';

export const ALL_PROMPT_TYPES: readonly PromptType[] = [
    'action', 'continue', 'fastforward', 'system', 'save', 'system_main', 'postprocess'
] as const;

@Injectable({
    providedIn: 'root'
})
export class InjectionService {
    private state = inject(GameStateService);
    private storage = inject(StorageService);
    private registry = inject(PromptProfileRegistryService);
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

    private async loadUserProfilePrompt(type: PromptType, profileId: string, langFolder: string, lang: string): Promise<string> {
        const visited = new Set<string>();
        let current: PromptProfile | undefined = this.registry.get(profileId);
        while (current && !visited.has(current.id)) {
            visited.add(current.id);

            const row = await this.storage.getProfilePrompt(type, current.id);
            if (row?.content !== undefined) return row.content;

            // Built-in IDB rows are only seeded for the active profile,
            // so a non-active base needs its shipped asset fetched on demand.
            if (current.isBuiltIn) {
                const seeded = await this.seedBuiltInAssetToIdb(type, langFolder, lang, current.id);
                if (seeded !== null) return seeded;
            }

            if (!current.baseProfileId) break;
            current = this.registry.get(current.baseProfileId);
        }
        const cloudRow = await this.storage.getProfilePrompt(type, DEFAULT_PROFILE_ID);
        return cloudRow?.content ?? '';
    }

    /** Returns null on fetch failure so callers can fall through to their next strategy. */
    private async seedBuiltInAssetToIdb(type: PromptType, langFolder: string, lang: string, profileId: string): Promise<string | null> {
        try {
            const filename = INJECTION_FILE_PATHS[type];
            const raw = await this.loadBuiltInAsset(langFolder, filename, profileId);
            const processed = type === 'postprocess' ? raw : this.applyPromptPlaceholders(raw, lang);
            await this.storage.saveProfilePrompt(type, profileId, processed);
            return processed;
        } catch (err) {
            console.warn(`[InjectionService] seedBuiltInAssetToIdb: failed for ${type} on '${profileId}'`, err);
            return null;
        }
    }

    markAsModified(type: PromptType): void {
        localStorage.setItem(this.lsKey(`prompt_user_modified_${type}`), 'true');
    }

    /** Throws on built-in profiles — UI must clone first. */
    async saveToService(type: PromptType, content: string): Promise<void> {
        const profile = this.registry.get(this.profileId);
        if (profile?.isBuiltIn) {
            throw new Error('Cannot save to a built-in profile. Clone it first.');
        }
        await this.storage.saveProfilePrompt(type, this.profileId, content);
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
            localStorage.setItem(this.lsKey(`prompt_user_modified_${type}`), 'false');
            await this.storage.saveProfilePrompt(type, this.profileId, status.serverContent);
        }

        const newHash = this.hashString(this.normalizeLineEndings(status.serverContent));
        localStorage.setItem(this.lsKey(`prompt_last_server_hash_${type}`), newHash);

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
            const savedEnabled = localStorage.getItem('enable_dynamic_injection');
            if (savedEnabled !== null) {
                this.state.enableDynamicInjection.set(savedEnabled === 'true');
            }

            const lang = localStorage.getItem('app_output_language') || localStorage.getItem('gemini_output_language') || 'default';
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

        let actionDef, continueDef, fastforwardDef, systemDef, saveDef, systemMainDef, postprocessDef;
        try {
            [actionDef, continueDef, fastforwardDef, systemDef, saveDef, systemMainDef, postprocessDef] =
                await Promise.all([
                    loadPath(INJECTION_FILE_PATHS.action),
                    loadPath(INJECTION_FILE_PATHS.continue),
                    loadPath(INJECTION_FILE_PATHS.fastforward),
                    loadPath(INJECTION_FILE_PATHS.system),
                    loadPath(INJECTION_FILE_PATHS.save),
                    loadPath(INJECTION_FILE_PATHS.system_main),
                    loadPath(INJECTION_FILE_PATHS.postprocess)
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
            { id: 'save', content: saveDef, legacyKey: 'dynamic_save_injection', isPost: false },
            { id: 'system_main', content: systemMainDef, legacyKey: '', isPost: false },
            { id: 'postprocess', content: postprocessDef, legacyKey: 'post_process_script', isPost: true }
        ] as const;

        const updateStatusMap = new Map<string, { hasUpdate: boolean, serverContent: string }>();

        for (const type of types) {
            const processedServerContent = type.isPost ? type.content : this.applyPromptPlaceholders(type.content, lang);
            const serverHash = this.hashString(this.normalizeLineEndings(processedServerContent));
            const hashKey = this.lsKey(`prompt_last_server_hash_${type.id}`, currentProfile);
            const modifiedKey = this.lsKey(`prompt_user_modified_${type.id}`, currentProfile);
            const lastServerHash = localStorage.getItem(hashKey);
            const isModified = localStorage.getItem(modifiedKey) === 'true';

            let hasUpdate = false;

            if (lastServerHash === null) {
                localStorage.setItem(hashKey, serverHash);
            } else if (serverHash !== lastServerHash) {
                if (isModified) {
                    hasUpdate = true;
                } else {
                    localStorage.setItem(hashKey, serverHash);
                }
            }

            updateStatusMap.set(type.id, { hasUpdate, serverContent: processedServerContent });

            let dbRecord = await this.storage.getProfilePrompt(type.id, currentProfile);

            // Pre-IDB customizations were stored in localStorage; migrate on read.
            if (!dbRecord && type.legacyKey && currentProfile === DEFAULT_PROFILE_ID) {
                const legacyContent = localStorage.getItem(type.legacyKey);
                if (legacyContent) {
                    console.log(`[InjectionService] Migrating ${type.id} from localStorage to IndexedDB`);
                    await this.storage.saveProfilePrompt(type.id, currentProfile, legacyContent);
                    dbRecord = { content: legacyContent, lastModified: Date.now() };
                    localStorage.removeItem(type.legacyKey);
                }
            }

            // `content !== undefined`, not truthiness — empty string is a valid customization.
            if (isModified && dbRecord?.content !== undefined) {
                this.setSignalContent(type.id as PromptType, dbRecord.content);
            } else {
                this.setSignalContent(type.id as PromptType, processedServerContent);
                localStorage.setItem(modifiedKey, 'false');

                // Seed default into IDB so a future clone has something to copy.
                if (!dbRecord) {
                    await this.storage.saveProfilePrompt(type.id, currentProfile, processedServerContent);
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
            case 'save': this.state.dynamicSaveInjection.set(content); break;
            case 'system_main': this.state.dynamicSystemMainInjection.set(content); break;
            case 'postprocess': this.state.postProcessScript.set(content); break;
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

        this.state.activePromptProfile.set(newProfileId);
        localStorage.setItem('app_active_prompt_profile', newProfileId);

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

        const lang = this.state.config()?.outputLanguage || localStorage.getItem('app_output_language') || localStorage.getItem('gemini_output_language') || 'default';
        const langFolder = getLangFolder(lang);

        for (const type of this.ALL_TYPES) {
            let row = await this.storage.getProfilePrompt(type, sourceId);

            // Non-active built-ins haven't been seeded to IDB; pull the asset on demand.
            if (!row && source.isBuiltIn) {
                const seeded = await this.seedBuiltInAssetToIdb(type, langFolder, lang, sourceId);
                if (seeded !== null) row = { content: seeded, lastModified: Date.now() };
            }

            if (row) {
                await this.storage.saveProfilePrompt(type, newId, row.content, row.tokens);
            }
        }

        // Inherit the source's modified-vs-default state at clone time; the new profile diverges from there.
        for (const type of this.ALL_TYPES) {
            for (const baseKey of [`prompt_user_modified_${type}`, `prompt_last_server_hash_${type}`]) {
                const sourceLsKey = getProfileScopedKey(baseKey, sourceId);
                const newLsKey = getProfileScopedKey(baseKey, newId);
                const value = localStorage.getItem(sourceLsKey);
                if (value !== null) localStorage.setItem(newLsKey, value);
            }
        }

        const meta = {
            id: newId,
            displayName,
            baseProfileId: sourceId,
            createdAt: now,
            updatedAt: now
        };
        await this.storage.putProfileMeta(meta);
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

        const meta = await this.storage.getProfileMeta(id);
        if (!meta) throw new Error(`Missing meta for profile: ${id}`);
        const updated = { ...meta, displayName, updatedAt: Date.now() };
        await this.storage.putProfileMeta(updated);
        this.registry.update(id, { displayName, updatedAt: updated.updatedAt });
    }

    /** Caller must switch off the active profile before calling this if `id` is currently active. */
    async deleteProfile(id: string): Promise<void> {
        const profile = this.registry.get(id);
        if (!profile) return;
        if (profile.isBuiltIn) throw new Error('Cannot delete a built-in profile');

        await this.storage.deleteAllProfilePrompts(id);
        for (const type of this.ALL_TYPES) {
            for (const baseKey of [`prompt_user_modified_${type}`, `prompt_last_server_hash_${type}`]) {
                localStorage.removeItem(getProfileScopedKey(baseKey, id));
            }
        }
        await this.storage.deleteProfileMeta(id);
        this.registry.remove(id);
    }

    getContentForType(type: PromptType): string {
        switch (type) {
            case 'action': return this.state.dynamicActionInjection();
            case 'continue': return this.state.dynamicContinueInjection();
            case 'fastforward': return this.state.dynamicFastforwardInjection();
            case 'system': return this.state.dynamicSystemInjection();
            case 'save': return this.state.dynamicSaveInjection();
            case 'system_main': return this.state.dynamicSystemMainInjection();
            case 'postprocess': return this.state.postProcessScript();
        }
    }
}
