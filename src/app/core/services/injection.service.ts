import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { INJECTION_FILE_PATHS } from '../constants/engine-protocol';
import { getLocale, getLangFolder } from '../constants/locales';

/**
 * Service responsible for managing dynamic prompt injection settings.
 * Handles loading, saving, and resetting injection prompts.
 */
@Injectable({
    providedIn: 'root'
})
export class InjectionService {
    private state = inject(GameStateService);
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
            .replace(/\{\{FILE_MAGIC\}\}/g, filenames.MAGIC)
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
            return (await response.text()).trim();
        } catch (err) {
            console.error(`[InjectionService] Failed to load injection file: ${path}`, err);
            return '';
        }
    }

    /**
     * Loads dynamic injection settings from localStorage or MD files.
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

            const [actionContent, continueContent, fastforwardContent, systemContent, saveContent, postprocessContent] =
                await Promise.all([
                    loadPath(INJECTION_FILE_PATHS.action),
                    loadPath(INJECTION_FILE_PATHS.continue),
                    loadPath(INJECTION_FILE_PATHS.fastforward),
                    loadPath(INJECTION_FILE_PATHS.system),
                    loadPath(INJECTION_FILE_PATHS.save),
                    loadPath(INJECTION_FILE_PATHS.postprocess)
                ]);

            const combinedContent =
                actionContent + continueContent + fastforwardContent + systemContent + saveContent;
            const currentHash = this.hashString(this.normalizeLineEndings(combinedContent));
            this.state.injectionContentHash = currentHash;

            const savedHash = localStorage.getItem('injection_content_hash');

            if (savedHash !== currentHash) {
                console.log('[InjectionService] Injection files changed, loading new content. Hash:', currentHash);

                this.state.dynamicActionInjection.set(this.applyPromptPlaceholders(actionContent, lang));
                this.state.dynamicContinueInjection.set(this.applyPromptPlaceholders(continueContent, lang));
                this.state.dynamicFastforwardInjection.set(this.applyPromptPlaceholders(fastforwardContent, lang));
                this.state.dynamicSystemInjection.set(this.applyPromptPlaceholders(systemContent, lang));
                this.state.dynamicSaveInjection.set(this.applyPromptPlaceholders(saveContent, lang));
                this.state.postProcessScript.set(postprocessContent);

                this.state.injectionSettingsLoaded.set(true);
                localStorage.setItem('injection_content_hash', currentHash);
                return;
            }

            // Same hash - load saved customizations from localStorage
            const savedAction = localStorage.getItem('dynamic_action_injection');
            if (savedAction !== null) this.state.dynamicActionInjection.set(savedAction);

            const savedContinue = localStorage.getItem('dynamic_continue_injection');
            if (savedContinue !== null) this.state.dynamicContinueInjection.set(savedContinue);

            const savedFastforward = localStorage.getItem('dynamic_fastforward_injection');
            if (savedFastforward !== null) this.state.dynamicFastforwardInjection.set(savedFastforward);

            const savedSystem = localStorage.getItem('dynamic_system_injection');
            if (savedSystem !== null) this.state.dynamicSystemInjection.set(savedSystem);

            const savedSave = localStorage.getItem('dynamic_save_injection');
            if (savedSave !== null) this.state.dynamicSaveInjection.set(savedSave);

            const savedPostprocess = localStorage.getItem('post_process_script');
            // Load from localStorage if exists, otherwise use default template
            this.state.postProcessScript.set(savedPostprocess !== null ? savedPostprocess : postprocessContent);

            this.state.injectionSettingsLoaded.set(true);
        } finally {
            this.isSettingsLoading = false;
        }
    }

    /**
     * Resets injection prompts to defaults from MD files.
     */
    async resetInjectionDefaults(
        type: 'action' | 'continue' | 'fastforward' | 'system' | 'save' | 'postprocess' | 'all' = 'all'
    ): Promise<void> {
        const loadAction = type === 'action' || type === 'all';
        const loadContinue = type === 'continue' || type === 'all';
        const loadFastforward = type === 'fastforward' || type === 'all';
        const loadSystem = type === 'system' || type === 'all';
        const loadSave = type === 'save' || type === 'all';
        const loadPostprocess = type === 'postprocess' || type === 'all';

        const lang =
            this.state.config()?.outputLanguage ||
            localStorage.getItem('gemini_output_language') ||
            'default';
        const langFolder = getLangFolder(lang);
        const folderPath = `assets/system_files/${langFolder}/`;

        const promises: Promise<string>[] = [];
        if (loadAction) promises.push(this.loadInjectionFile(folderPath + INJECTION_FILE_PATHS.action));
        if (loadContinue) promises.push(this.loadInjectionFile(folderPath + INJECTION_FILE_PATHS.continue));
        if (loadFastforward) promises.push(this.loadInjectionFile(folderPath + INJECTION_FILE_PATHS.fastforward));
        if (loadSystem) promises.push(this.loadInjectionFile(folderPath + INJECTION_FILE_PATHS.system));
        if (loadSave) promises.push(this.loadInjectionFile(folderPath + INJECTION_FILE_PATHS.save));
        if (loadPostprocess) promises.push(this.loadInjectionFile(folderPath + INJECTION_FILE_PATHS.postprocess));

        const results = await Promise.all(promises);
        let idx = 0;

        if (loadAction) this.state.dynamicActionInjection.set(this.applyPromptPlaceholders(results[idx++], lang));
        if (loadContinue) this.state.dynamicContinueInjection.set(this.applyPromptPlaceholders(results[idx++], lang));
        if (loadFastforward) this.state.dynamicFastforwardInjection.set(this.applyPromptPlaceholders(results[idx++], lang));
        if (loadSystem) this.state.dynamicSystemInjection.set(this.applyPromptPlaceholders(results[idx++], lang));
        if (loadSave) this.state.dynamicSaveInjection.set(this.applyPromptPlaceholders(results[idx++], lang));
        if (loadPostprocess) this.state.postProcessScript.set(results[idx++]);

        if (type === 'all') {
            const combined =
                this.state.dynamicActionInjection() +
                this.state.dynamicContinueInjection() +
                this.state.dynamicFastforwardInjection() +
                this.state.dynamicSystemInjection() +
                this.state.dynamicSaveInjection();
            const newHash = this.hashString(this.normalizeLineEndings(combined));
            this.state.injectionContentHash = newHash;
            localStorage.setItem('injection_content_hash', newHash);
        }

        console.log(`[InjectionService] Reset injection defaults: ${type}`);
    }
}
