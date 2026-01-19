import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { INJECTION_FILE_PATHS } from '../constants/engine-protocol';
import { getLocale, getLangFolder } from '../constants/locales';
import { StorageService } from './storage.service';

export type PromptType = 'action' | 'continue' | 'fastforward' | 'system' | 'save' | 'audit' | 'postprocess' | 'system_main';

/**
 * Service responsible for managing dynamic prompt injection settings.
 * Handles loading, saving, and resetting injection prompts.
 */
@Injectable({
    providedIn: 'root'
})
export class InjectionService {
    private state = inject(GameStateService);
    private storage = inject(StorageService);
    private isSettingsLoading = false;

    /**
     * Normalizes line endings to LF for consistent hashing across platforms.
     */
    private normalizeLineEndings(str: string): string {
        return str.replace(/\r\n/g, '\n');
    }

    /**
     * Generates a 32-bit integer string hash for a given string.
     */
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

    /**
     * Replaces placeholders in a prompt string with localized values.
     */
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

    /**
     * Loads a single injection file from assets.
     */
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

    /**
     * Marks a specific injection type as modified by the user.
     */
    markAsModified(type: PromptType): void {
        localStorage.setItem(`prompt_user_modified_${type}`, 'true');
    }

    /**
     * Saves the current content of a prompt to storage.
     */
    async saveToService(type: PromptType, content: string): Promise<void> {
        await this.storage.savePrompt(type, content);
        this.markAsModified(type);

        // Update the signal immediately
        switch (type) {
            case 'action': this.state.dynamicActionInjection.set(content); break;
            case 'continue': this.state.dynamicContinueInjection.set(content); break;
            case 'fastforward': this.state.dynamicFastforwardInjection.set(content); break;
            case 'system': this.state.dynamicSystemInjection.set(content); break;
            case 'save': this.state.dynamicSaveInjection.set(content); break;
            case 'audit': this.state.dynamicAuditInjection.set(content); break;
            case 'system_main': this.state.dynamicSystemMainInjection.set(content); break;
            case 'postprocess': this.state.postProcessScript.set(content); break;
        }
    }

    /**
     * Acknowledges an update for a specific type, updating the last seen hash.
     * Optionally overwrites the user's content.
     */
    async acknowledgeUpdate(type: PromptType, applyUpdate: boolean): Promise<void> {
        const status = this.state.promptUpdateStatus().get(type);
        if (!status) return;

        if (applyUpdate) {
            switch (type) {
                case 'action': this.state.dynamicActionInjection.set(status.serverContent); break;
                case 'continue': this.state.dynamicContinueInjection.set(status.serverContent); break;
                case 'fastforward': this.state.dynamicFastforwardInjection.set(status.serverContent); break;
                case 'system': this.state.dynamicSystemInjection.set(status.serverContent); break;
                case 'save': this.state.dynamicSaveInjection.set(status.serverContent); break;
                case 'audit': this.state.dynamicAuditInjection.set(status.serverContent); break;
                case 'system_main': this.state.dynamicSystemMainInjection.set(status.serverContent); break;
                case 'postprocess': this.state.postProcessScript.set(status.serverContent); break;
            }
            // If they apply the update, it's no longer "modified" relative to the new server version
            localStorage.setItem(`prompt_user_modified_${type}`, 'false');
            await this.storage.savePrompt(type, status.serverContent);
        }

        const newHash = this.hashString(this.normalizeLineEndings(status.serverContent));
        localStorage.setItem(`prompt_last_server_hash_${type}`, newHash);

        // Update status map
        this.state.promptUpdateStatus.update(map => {
            const newMap = new Map(map);
            newMap.set(type, { ...status, hasUpdate: false });
            return newMap;
        });
    }

    /**
     * Loads dynamic injection settings from StorageService (IndexedDB) or MD files.
     * Includes migration from legacy localStorage.
     */
    async loadDynamicInjectionSettings() {
        if (this.isSettingsLoading) return;
        this.isSettingsLoading = true;

        try {
            const savedEnabled = localStorage.getItem('enable_dynamic_injection');
            if (savedEnabled !== null) {
                this.state.enableDynamicInjection.set(savedEnabled === 'true');
            }

            const lang = localStorage.getItem('gemini_output_language') || 'default';
            const langFolder = getLangFolder(lang);
            const loadPath = (filename: string) =>
                this.loadInjectionFile(`assets/system_files/${langFolder}/${filename}`);

            // We must catch errors here; if any fails, we halt system
            let actionDef, continueDef, fastforwardDef, systemDef, saveDef, auditDef, systemMainDef, postprocessDef;

            try {
                [actionDef, continueDef, fastforwardDef, systemDef, saveDef, auditDef, systemMainDef, postprocessDef] =
                    await Promise.all([
                        loadPath(INJECTION_FILE_PATHS.action),
                        loadPath(INJECTION_FILE_PATHS.continue),
                        loadPath(INJECTION_FILE_PATHS.fastforward),
                        loadPath(INJECTION_FILE_PATHS.system),
                        loadPath(INJECTION_FILE_PATHS.save),
                        loadPath(INJECTION_FILE_PATHS.audit),
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
                { id: 'audit', content: auditDef, legacyKey: 'dynamic_audit_injection', isPost: false },
                { id: 'system_main', content: systemMainDef, legacyKey: '', isPost: false }, // system_main was previously in file_store, not LS
                { id: 'postprocess', content: postprocessDef, legacyKey: 'post_process_script', isPost: true }
            ] as const;

            const updateStatusMap = new Map<string, { hasUpdate: boolean, serverContent: string }>();

            for (const type of types) {
                const processedServerContent = type.isPost ? type.content : this.applyPromptPlaceholders(type.content, lang);
                const serverHash = this.hashString(this.normalizeLineEndings(processedServerContent));
                const lastServerHash = localStorage.getItem(`prompt_last_server_hash_${type.id}`);
                const isModified = localStorage.getItem(`prompt_user_modified_${type.id}`) === 'true';

                let hasUpdate = false;

                if (lastServerHash === null) {
                    localStorage.setItem(`prompt_last_server_hash_${type.id}`, serverHash);
                } else if (serverHash !== lastServerHash) {
                    if (isModified) {
                        hasUpdate = true;
                    } else {
                        localStorage.setItem(`prompt_last_server_hash_${type.id}`, serverHash);
                    }
                }

                updateStatusMap.set(type.id, { hasUpdate, serverContent: processedServerContent });

                // Try to load from IndexedDB
                let dbRecord = await this.storage.getPrompt(type.id);

                // DATA MIGRATION: Check localStorage if not in DB
                if (!dbRecord && type.legacyKey) {
                    const legacyContent = localStorage.getItem(type.legacyKey);
                    if (legacyContent) {
                        console.log(`[InjectionService] Migrating ${type.id} from localStorage to IndexedDB`);
                        await this.storage.savePrompt(type.id, legacyContent);
                        dbRecord = { content: legacyContent, lastModified: Date.now() };
                        localStorage.removeItem(type.legacyKey);
                    }
                }

                // Decide what to load into the signal
                if (isModified && dbRecord?.content?.trim()) {
                    // Load user customization
                    this.setSignalContent(type.id as PromptType, dbRecord.content);
                } else {
                    // Load server default
                    this.setSignalContent(type.id as PromptType, processedServerContent);
                    localStorage.setItem(`prompt_user_modified_${type.id}`, 'false');

                    // CRITICAL: Ensure the default content is in IDB to support "Unify Storage"
                    // If we don't save it here, it won't be in prompt_store until modified.
                    // We only save if legacyKey is empty (system_main) OR if it's not in DB yet.
                    if (!dbRecord) {
                        await this.storage.savePrompt(type.id, processedServerContent);
                    }
                }
            }

            this.state.promptUpdateStatus.set(updateStatusMap);
            this.state.injectionSettingsLoaded.set(true);
        } catch (globalErr: unknown) {
            console.error('[InjectionService] Global error in loader', globalErr);
            this.state.status.set('error');
            const msg = globalErr instanceof Error ? globalErr.message : String(globalErr);
            this.state.criticalError.set(msg || 'Unknown system error');
        } finally {
            this.isSettingsLoading = false;
        }
    }

    private setSignalContent(type: PromptType, content: string) {
        switch (type) {
            case 'action': this.state.dynamicActionInjection.set(content); break;
            case 'continue': this.state.dynamicContinueInjection.set(content); break;
            case 'fastforward': this.state.dynamicFastforwardInjection.set(content); break;
            case 'system': this.state.dynamicSystemInjection.set(content); break;
            case 'save': this.state.dynamicSaveInjection.set(content); break;
            case 'audit': this.state.dynamicAuditInjection.set(content); break;
            case 'system_main': this.state.dynamicSystemMainInjection.set(content); break;
            case 'postprocess': this.state.postProcessScript.set(content); break;
        }
    }

    /**
     * Resets injection prompts to defaults from MD files.
     */
    async resetInjectionDefaults(type: PromptType | 'all' = 'all'): Promise<void> {
        const loadAction = type === 'action' || type === 'all';
        const loadContinue = type === 'continue' || type === 'all';
        const loadFastforward = type === 'fastforward' || type === 'all';
        const loadSystem = type === 'system' || type === 'all';
        const loadSave = type === 'save' || type === 'all';
        const loadAudit = type === 'audit' || type === 'all';
        const loadSystemMain = type === 'system_main' || type === 'all';
        const loadPostprocess = type === 'postprocess' || type === 'all';

        const lang = this.state.config()?.outputLanguage || localStorage.getItem('gemini_output_language') || 'default';
        const langFolder = getLangFolder(lang);
        const folderPath = `assets/system_files/${langFolder}/`;

        const promises: Promise<{ id: PromptType, content: string }>[] = [];
        const wrapLoad = async (id: PromptType, filename: string) => ({ id, content: await this.loadInjectionFile(folderPath + filename) });

        if (loadAction) promises.push(wrapLoad('action', INJECTION_FILE_PATHS.action));
        if (loadContinue) promises.push(wrapLoad('continue', INJECTION_FILE_PATHS.continue));
        if (loadFastforward) promises.push(wrapLoad('fastforward', INJECTION_FILE_PATHS.fastforward));
        if (loadSystem) promises.push(wrapLoad('system', INJECTION_FILE_PATHS.system));
        if (loadSave) promises.push(wrapLoad('save', INJECTION_FILE_PATHS.save));
        if (loadAudit) promises.push(wrapLoad('audit', INJECTION_FILE_PATHS.audit));
        if (loadSystemMain) promises.push(wrapLoad('system_main', INJECTION_FILE_PATHS.system_main));
        if (loadPostprocess) promises.push(wrapLoad('postprocess', INJECTION_FILE_PATHS.postprocess));

        const results = await Promise.all(promises);

        for (const res of results) {
            const processedContent = res.id === 'postprocess' ? res.content : this.applyPromptPlaceholders(res.content, lang);
            this.setSignalContent(res.id, processedContent);

            // Update IDB and hashes
            // Note: If we reset, we effectively remove the "customization" in IDB and LS
            const hash = this.hashString(this.normalizeLineEndings(processedContent));
            localStorage.setItem(`prompt_last_server_hash_${res.id}`, hash);
            localStorage.setItem(`prompt_user_modified_${res.id}`, 'false');

            // CLEAR customization from IDB by saving the default content
            // or we could just delete it from IDB. But saving default content is safer for "current" state.
            await this.storage.savePrompt(res.id, processedContent);

            // Update status map to clear update badge
            this.state.promptUpdateStatus.update(map => {
                const newMap = new Map(map);
                const status = newMap.get(res.id);
                if (status) {
                    newMap.set(res.id, { ...status, hasUpdate: false });
                }
                return newMap;
            });
        }

        console.log(`[InjectionService] Reset injection defaults: ${type}`);
    }

    /**
     * Helper to get current signal content by type
     */
    getContentForType(type: PromptType): string {
        switch (type) {
            case 'action': return this.state.dynamicActionInjection();
            case 'continue': return this.state.dynamicContinueInjection();
            case 'fastforward': return this.state.dynamicFastforwardInjection();
            case 'system': return this.state.dynamicSystemInjection();
            case 'save': return this.state.dynamicSaveInjection();
            case 'audit': return this.state.dynamicAuditInjection();
            case 'system_main': return this.state.dynamicSystemMainInjection();
            case 'postprocess': return this.state.postProcessScript();
        }
    }
}
