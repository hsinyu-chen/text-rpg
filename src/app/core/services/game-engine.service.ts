import { Injectable, inject } from '@angular/core';

import { GameStateService } from './game-state.service';
import { ChatHistoryService } from './chat-history.service';
import { CacheManagerService } from './cache-manager.service';
import { SessionService } from './session.service';
import { ConfigService } from './config.service';
import { AppConfigShape } from './app-config-store';
import { SessionSave, Scenario } from '../models/types';

import { SceneBootService } from './scene-boot.service';
import { TurnPipelineService, RunTurnOptions } from './turn-pipeline.service';

/**
 * Top-level entry point that fronts the per-turn pipeline, scene boot, and
 * the session / config / cache / chat-history facades. Logic lives in the
 * dedicated services below; this class is a single injection point so
 * components don't need to wire four separate services for one user action.
 */
@Injectable({ providedIn: 'root' })
export class GameEngineService {
    private state = inject(GameStateService);
    private chatHistory = inject(ChatHistoryService);
    private cacheManager = inject(CacheManagerService);
    private session = inject(SessionService);
    private configService = inject(ConfigService);
    private sceneBoot = inject(SceneBootService);
    private turnPipeline = inject(TurnPipelineService);

    /** Bootstraps engine subsystems via ConfigService. Call AFTER registering LLM Providers. */
    init() {
        this.configService.init();
    }

    // ===== Turn pipeline (delegated) =========================================

    sendMessage(userText: string, options?: RunTurnOptions) {
        return this.turnPipeline.runTurn(userText, options);
    }

    stopGeneration() {
        this.turnPipeline.stopGeneration();
    }

    getPreviewPayload(userText: string, options?: { intent?: string }) {
        return this.turnPipeline.getPreviewPayload(userText, options);
    }

    /**
     * Initializes the story session via local fast-path scene extraction;
     * falls back to LLM generation when no marker is found.
     */
    async startSession() {
        if (!this.state.isConfigured() || this.state.loadedFiles().size === 0) {
            console.log('[GameEngine] startSession aborted: Engine not configured or Knowledge Base is empty.');
            return;
        }
        if (this.state.messages().length > 0) return;

        const result = await this.sceneBoot.tryLocalBoot();
        if (!result.bootedLocally) {
            this.sendMessage(result.fallbackText, { isHidden: true });
        }
    }

    // ===== Config facades ====================================================

    saveConfig(genConfig: Partial<AppConfigShape>) { return this.configService.saveConfig(genConfig); }
    importConfig(config: unknown) { this.configService.importConfig(config); }

    // ===== Session facades ===================================================

    exportSession(): SessionSave { return this.session.exportSession(); }
    importSession(save: SessionSave) { return this.session.importSession(save); }
    importFiles(files: Map<string, string>) { return this.session.importFiles(files); }
    updateSingleFile(filePath: string, content: string) { return this.session.updateSingleFile(filePath, content); }
    saveCurrentSessionToBook() { return this.session.saveCurrentSessionToBook(); }

    /**
     * Loads files from a directory and initializes the Knowledge Base.
     * Defaults to bumpTimestamp=true: callers reaching the engine layer are
     * user-driven actions (button click, post-LLM-update reload, folder pick),
     * which represent real KB-content change. Programmatic re-reads that are
     * NOT a real change (startup hydration, language toggle) call
     * session.loadFiles directly with bumpTimestamp=false instead.
     */
    loadFiles(pickFolder = true, bumpTimestamp = true) {
        return this.session.loadFiles(pickFolder, bumpTimestamp);
    }

    /** Completely wipes all local game progress. */
    wipeLocalSession() { return this.session.unloadCurrentSession(false); }

    async startNewGame(profile: {
        name: string,
        faction: string,
        background: string,
        interests: string,
        appearance: string
    }, scenario: Scenario) {
        await this.session.startNewGame(profile, scenario);
        await this.startSession();
    }

    // ===== Cache facades =====================================================

    cleanupCache() { return this.cacheManager.cleanupCache(); }
    clearAllServerCaches() { return this.cacheManager.clearAllServerCaches(); }
    releaseCache() { return this.cacheManager.releaseCache(); }

    // ===== Chat history facades ==============================================
    // ChatHistoryService persists the book itself; these are 1-line proxies
    // so callsites keep a single injection point (GameEngineService).

    updateMessageContent(id: string, newContent: string) { return this.chatHistory.updateMessageContent(id, newContent); }
    updateMessageLogs(id: string, type: 'inventory' | 'quest' | 'world' | 'character', logs: string[]) { return this.chatHistory.updateMessageLogs(id, type, logs); }
    updateMessageSummary(id: string, summary: string) { return this.chatHistory.updateMessageSummary(id, summary); }
    updateMessageCorrection(id: string, correction: string) { return this.chatHistory.updateMessageCorrection(id, correction); }
    deleteMessage(id: string) { return this.chatHistory.deleteMessage(id); }
    deleteMessages(ids: string[]) { return this.chatHistory.deleteMessages(ids); }
    deleteFrom(id: string) { return this.chatHistory.deleteFrom(id); }
    rewindTo(messageId: string) { return this.chatHistory.rewindTo(messageId); }
    toggleRefOnly(id: string) { return this.chatHistory.toggleRefOnly(id); }
    clearHistory() { return this.chatHistory.clearHistory(); }
}
