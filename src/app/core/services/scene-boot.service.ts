import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { SessionService } from './session.service';
import { ChatHistoryService } from './chat-history.service';
import { AppConfigStore } from './app-config-store';
import { LOCALES } from '../constants/locales';
import { getAdultDeclaration, getEngineStrings, getSectionHeaders } from '../constants/engine-protocol';

export type LocalBootResult =
    | { bootedLocally: true }
    | { bootedLocally: false; fallbackText: string };

/**
 * Local-fast-path scene boot. Three-layer fallback:
 *   1. `last_scene` marker in STORY_OUTLINE (regex tolerant of #/_/* decoration)
 *   2. `## 開始場景` / `## Start Scene` section header
 *   3. No marker — caller kicks LLM with the returned `fallbackText`
 *
 * On success commits the intro user msg + scene model msg and persists; on
 * failure returns the language-appropriate intro text for the LLM path.
 * Caller decides whether to invoke LLM (avoids a circular dep on the engine).
 */
@Injectable({ providedIn: 'root' })
export class SceneBootService {
    private state = inject(GameStateService);
    private session = inject(SessionService);
    private chatHistory = inject(ChatHistoryService);
    private appConfig = inject(AppConfigStore);

    async tryLocalBoot(): Promise<LocalBootResult> {
        const lang = this.appConfig.outputLanguage();
        const introText = getEngineStrings(lang).INTRO_TEXT;

        const outline = this.findStoryOutline();
        if (!outline) return { bootedLocally: false, fallbackText: introText };
        const { fileName, content } = outline;

        const matchedLocale = Object.values(LOCALES).find(l => l.coreFilenames.STORY_OUTLINE === fileName);
        const langId = matchedLocale ? matchedLocale.id : lang;

        const lastScene = this.extractLastScene(content);
        if (lastScene) {
            console.log('[SceneBoot] Local Initialization: Extracted last_scene from', fileName);
            await this.commitBootMessages(introText, lastScene, langId);
            await this.session.saveCurrentSessionToBook();
            return { bootedLocally: true };
        }

        const startScene = this.extractStartScene(content, langId);
        if (startScene) {
            console.log('[SceneBoot] Local Initialization: Extracted start scene from', fileName);
            await this.commitBootMessages(introText, startScene, langId);
            await this.session.saveCurrentSessionToBook();
            return { bootedLocally: true };
        }

        console.log('[SceneBoot] Local Initialization Failed: No marker found or file empty. Falling back to LLM generation.');
        return { bootedLocally: false, fallbackText: introText };
    }

    private findStoryOutline(): { fileName: string; content: string } | null {
        const candidates = new Set(Object.values(LOCALES).map(l => l.coreFilenames.STORY_OUTLINE));
        const files = this.state.loadedFiles();
        for (const name of candidates) {
            const content = files.get(name);
            if (content !== undefined) return { fileName: name, content };
        }
        return null;
    }

    /** Tolerant of decoration: `# last_scene`, `**last_scene**:`, `last_scene:` etc. */
    private extractLastScene(content: string): string {
        const regex = /(?:^|\n)(?:[#*_\s]*last[_-]?scene[#*_\s]*[:：]?\s*)([\s\S]*)$/i;
        const match = content.match(regex);
        return match?.[1]?.trim() ?? '';
    }

    private extractStartScene(content: string, langId: string): string {
        const header = getSectionHeaders(langId).START_SCENE;
        if (!content.includes(header)) return '';
        return content.split(header)[1].split(/\n---|\n##/)[0].trim();
    }

    private async commitBootMessages(introText: string, scene: string, langId: string): Promise<void> {
        const declaration = this.appConfig.enableAdultDeclaration() === false ? '' : getAdultDeclaration(langId);
        const eng = getEngineStrings(langId);
        await this.chatHistory.updateMessages(prev => [
            ...prev,
            {
                id: crypto.randomUUID(),
                role: 'user',
                content: introText,
                parts: [{ text: introText }],
                isHidden: true
            },
            {
                id: crypto.randomUUID(),
                role: 'model',
                content: declaration + scene,
                parts: [{ text: declaration + scene }],
                analysis: eng.LOCAL_INIT_ANALYSIS
            }
        ]);
    }
}
