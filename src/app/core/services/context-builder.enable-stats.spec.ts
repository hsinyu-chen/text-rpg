import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { ContextBuilderService } from './context-builder.service';
import { GameStateService } from './game-state.service';
import { AppConfigStore } from './app-config-store';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { KnowledgeService } from './knowledge.service';
import { LanguageService } from './language.service';
import { StatLedgerService } from './stats/stat-ledger.service';

/**
 * snapshotForTurn reads ~20 signals; stub each as a constant accessor so the
 * spec can assert the one derivation under test (enableStatsSystem) in
 * isolation, without the engine's DI graph.
 */
function makeBuilder(opts: { hasStatsYaml: boolean; engineMode: 'single' | 'two-call' }): ContextBuilderService {
    const stateStub = {
        messages: () => [],
        contextMode: () => 'smart',
        saveContextMode: () => 'smart',
        systemInstructionCache: () => '',
        loadedFiles: () => new Map<string, string>(),
        kbCacheName: () => null,
        dynamicActionInjection: () => '',
        dynamicContinueInjection: () => '',
        dynamicFastforwardInjection: () => '',
        dynamicSystemInjection: () => '',
        dynamicProtocolResolverInjection: () => '',
        dynamicProtocolNarratorInjection: () => '',
        dynamicProtocolSingleInjection: () => '',
        dynamicCorrectionInjection: () => '',
        hasStatsYaml: () => opts.hasStatsYaml,
    };
    const appConfigStub = {
        smartContextTurns: () => 5,
        engineMode: () => opts.engineMode,
        outputLanguage: () => 'English',
    };
    const providerRegistryStub = {
        getActive: () => null,
        getActiveModelId: () => '',
    };

    const injector = Injector.create({
        providers: [
            { provide: GameStateService, useValue: stateStub },
            { provide: AppConfigStore, useValue: appConfigStub },
            { provide: LLMProviderRegistryService, useValue: providerRegistryStub },
            { provide: KnowledgeService, useValue: {} },
            { provide: LanguageService, useValue: {} },
            { provide: StatLedgerService, useClass: StatLedgerService },
        ],
    });
    return runInInjectionContext(injector, () => new ContextBuilderService());
}

describe('snapshotForTurn enableStatsSystem', () => {
    it('is true only when the Book opts in AND mode is two-call', () => {
        expect(makeBuilder({ hasStatsYaml: true, engineMode: 'two-call' }).snapshotForTurn().enableStatsSystem).toBe(true);
    });

    it('is false on two-call when the Book has no stats file', () => {
        expect(makeBuilder({ hasStatsYaml: false, engineMode: 'two-call' }).snapshotForTurn().enableStatsSystem).toBe(false);
    });

    it('is false for a stats Book left in single mode (the gate path)', () => {
        expect(makeBuilder({ hasStatsYaml: true, engineMode: 'single' }).snapshotForTurn().enableStatsSystem).toBe(false);
    });

    it('is false when neither holds', () => {
        expect(makeBuilder({ hasStatsYaml: false, engineMode: 'single' }).snapshotForTurn().enableStatsSystem).toBe(false);
    });
});
