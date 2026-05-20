import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ContextBuilderService, BuildContext } from './context-builder.service';
import { KnowledgeService } from './knowledge.service';
import { LanguageService } from './language.service';
import { GameStateService } from './game-state.service';
import { KVStore } from './kv/kv-store';
import { InMemoryKVStore } from '../testing/in-memory-kv-store';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import type { ChatMessage } from '../models/types';

function modelMsg(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: 'm-' + Math.random().toString(36).slice(2, 8),
        role: 'model',
        content,
        parts: [{ text: content }],
        ...extra
    };
}

function userMsg(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: 'u-' + Math.random().toString(36).slice(2, 8),
        role: 'user',
        content,
        parts: [{ text: content }],
        ...extra
    };
}

function emptyCtx(overrides: Partial<BuildContext> = {}): BuildContext {
    return {
        messages: [],
        contextMode: 'full',
        saveContextMode: 'full',
        smartContextTurns: 10,
        systemInstructionCache: 'SYS',
        loadedFiles: new Map(),
        kbCacheName: null,
        providerCapabilities: { cacheBakesContent: true } as BuildContext['providerCapabilities'],
        dynamicAction: '',
        dynamicContinue: '',
        dynamicFastforward: '',
        dynamicSystem: '',
        dynamicProtocolResolver: '',
        dynamicProtocolNarrator: '',
        dynamicProtocolSingle: '',
        dynamicCorrection: '',
        engineMode: 'single',
        ...overrides
    };
}

describe('ContextBuilderService', () => {
    let builder: ContextBuilderService;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                ContextBuilderService,
                LanguageService,
                KnowledgeService,
                { provide: KVStore, useValue: new InMemoryKVStore() },
                { provide: GameStateService, useValue: {} as unknown as GameStateService },
                { provide: LLMProviderRegistryService, useValue: { getActive: () => null } }
            ]
        });

        builder = TestBed.inject(ContextBuilderService);
    });

    describe('getLLMHistory', () => {
        it('returns empty when ctx.messages is empty', () => {
            expect(builder.getLLMHistory(emptyCtx())).toEqual([]);
        });

        it('passes through messages in full mode without summary blocks', () => {
            const ctx = emptyCtx({
                messages: [
                    userMsg('hello'),
                    modelMsg('hi there')
                ]
            });
            const history = builder.getLLMHistory(ctx);
            expect(history.length).toBe(2);
            expect(history[0].role).toBe('user');
            expect(history[1].role).toBe('model');
            expect(history[0].parts[0].text).toContain('hello');
        });

        it('drops ref-only messages by default', () => {
            const ctx = emptyCtx({
                messages: [
                    userMsg('kept'),
                    modelMsg('dropped', { isRefOnly: true }),
                    userMsg('also kept')
                ]
            });
            const history = builder.getLLMHistory(ctx);
            expect(history.length).toBe(2);
            expect(history[0].parts[0].text).toContain('kept');
            expect(history[1].parts[0].text).toContain('also kept');
        });

        it('rolls past messages into a stable summary block once size threshold is reached', () => {
            // Need >= SUMMARY_BLOCK_SIZE (10) model messages with summary content
            // PAST the recent window (smartContextTurns * 2 = 4 in this test).
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 12; i++) {
                msgs.push(userMsg(`u${i}`));
                msgs.push(modelMsg(`m${i}`, {
                    intent: 'action',
                    summary: `summary-${i}`
                }));
            }

            const ctx = emptyCtx({
                messages: msgs,
                contextMode: 'smart',
                smartContextTurns: 2  // recent window = 4 → 20 messages past, leaves room for a 10-block
            });

            const history = builder.getLLMHistory(ctx);
            // First content should be a summary block (role=user) containing
            // multiple `summary-X` lines.
            expect(history[0].role).toBe('user');
            expect(history[0].parts[0].text).toContain('summary-0');
            expect(history[0].parts[0].text).toContain('summary-9');
            // Recent messages still present at the tail.
            const tailText = history[history.length - 1].parts[0].text;
            expect(tailText).toBeTruthy();
        });

        it('uses saveContextMode when forceFullContext is true', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 8; i++) {
                msgs.push(userMsg(`u${i}`));
                msgs.push(modelMsg(`m${i}`, { intent: 'action', summary: `s-${i}` }));
            }

            const summarized = builder.getLLMHistory(emptyCtx({
                messages: msgs,
                contextMode: 'summarized',  // would compact past
                saveContextMode: 'full'     // forceFullContext switch
            }), true);

            // forceFullContext=true → use saveContextMode='full' → no summary roll-up
            expect(summarized[0].role).toBe('user');
            expect(summarized[0].parts[0].text).toContain('u0');
        });

        it('honours custom filter predicate', () => {
            const ctx = emptyCtx({
                messages: [
                    userMsg('A'),
                    modelMsg('B'),
                    userMsg('C')
                ]
            });
            // Drop user messages.
            const history = builder.getLLMHistory(ctx, false, m => m.role !== 'user');
            expect(history.length).toBe(1);
            expect(history[0].role).toBe('model');
        });
    });

    describe('shouldOmitKbFromSystemInstruction', () => {
        it('returns false when no cache is active', () => {
            const ctx = emptyCtx({ kbCacheName: null });
            expect(builder.shouldOmitKbFromSystemInstruction(ctx)).toBe(false);
        });

        it('returns false when cache is active but provider does not bake KB into the cache (e.g. llama.cpp prefix-match)', () => {
            const ctx = emptyCtx({
                kbCacheName: 'cache-1',
                providerCapabilities: { cacheBakesContent: false } as BuildContext['providerCapabilities']
            });
            expect(builder.shouldOmitKbFromSystemInstruction(ctx)).toBe(false);
        });

        it('returns true when cache is active and provider bakes KB content server-side (e.g. Gemini)', () => {
            const ctx = emptyCtx({
                kbCacheName: 'cache-1',
                providerCapabilities: { cacheBakesContent: true } as BuildContext['providerCapabilities']
            });
            expect(builder.shouldOmitKbFromSystemInstruction(ctx)).toBe(true);
        });
    });

    describe('getEffectiveSystemInstruction', () => {
        it('strips the system-main version marker from the cached prompt', () => {
            const ctx = emptyCtx({
                systemInstructionCache: '<!-- @system-main-version: 2 -->\n\n# Body'
            });
            const out = builder.getEffectiveSystemInstruction(ctx, false);
            expect(out).not.toContain('@system-main-version');
            expect(out).toContain('# Body');
        });

        it('appends KB content when includeKB is true and loadedFiles has entries', () => {
            const ctx = emptyCtx({
                systemInstructionCache: 'SYS',
                loadedFiles: new Map([['a.md', 'KB-CONTENT']])
            });
            const out = builder.getEffectiveSystemInstruction(ctx, true);
            expect(out).toContain('SYS');
            expect(out).toContain('KB-CONTENT');
        });

        it('omits KB content when includeKB is false', () => {
            const ctx = emptyCtx({
                systemInstructionCache: 'SYS',
                loadedFiles: new Map([['a.md', 'KB-CONTENT']])
            });
            const out = builder.getEffectiveSystemInstruction(ctx, false);
            expect(out).toBe('SYS');
        });
    });

    describe('intentInjection', () => {
        it('returns the matching dynamic injection for each known intent', () => {
            const ctx = emptyCtx({
                dynamicAction: 'A',
                dynamicContinue: 'C',
                dynamicFastforward: 'F',
                dynamicSystem: 'SYS',
            });
            expect(builder.intentInjection(ctx, 'action')).toBe('A');
            expect(builder.intentInjection(ctx, 'continue')).toBe('C');
            expect(builder.intentInjection(ctx, 'fast_forward')).toBe('F');
            expect(builder.intentInjection(ctx, 'system')).toBe('SYS');
        });

        it('returns empty string for SAVE intent (handled by MultiAgentSaveService, not the turn engine)', () => {
            // The dynamicSave context field was retired; SAVE never had any
            // way to inject into the turn-engine path again.
            expect(builder.intentInjection(emptyCtx(), 'save')).toBe('');
        });

        it('returns empty string for unknown intent', () => {
            expect(builder.intentInjection(emptyCtx(), 'unknown-intent')).toBe('');
        });
    });

    describe('augmentSingleCallHistory', () => {
        it('substitutes {{IDEAL_OUTCOME_CONSTRAINT}} into protocol_single when the latest user msg supplied userIdealOutcome', () => {
            const user = userMsg('walk forward', { userIdealOutcome: 'reach the plaza unseen' });
            const ctx = emptyCtx({
                messages: [user],
                dynamicAction: 'ACTION: {{USER_INPUT}}',
                dynamicProtocolSingle: 'PROTOCOL\n\n{{IDEAL_OUTCOME_CONSTRAINT}}\n\n{{USER_INPUT}}'
            });

            const history = builder.augmentSingleCallHistory(
                ctx,
                [{ role: 'user', parts: [{ text: 'walk forward' }] }],
                'action',
                'zh-tw'
            );

            const tail = history[history.length - 1].parts[0].text!;
            expect(tail).toContain('reach the plaza unseen');
            expect(tail).not.toContain('{{IDEAL_OUTCOME_CONSTRAINT}}');
        });

        it('drops {{IDEAL_OUTCOME_CONSTRAINT}} to empty when no userIdealOutcome was supplied', () => {
            const user = userMsg('walk forward');
            const ctx = emptyCtx({
                messages: [user],
                dynamicAction: 'ACTION: {{USER_INPUT}}',
                dynamicProtocolSingle: 'PROTOCOL\n\n{{IDEAL_OUTCOME_CONSTRAINT}}\n\n{{USER_INPUT}}'
            });

            const history = builder.augmentSingleCallHistory(
                ctx,
                [{ role: 'user', parts: [{ text: 'walk forward' }] }],
                'action',
                'zh-tw'
            );

            const tail = history[history.length - 1].parts[0].text!;
            expect(tail).not.toContain('{{IDEAL_OUTCOME_CONSTRAINT}}');
            expect(tail).not.toContain('使用者聲明的 ideal_outcome');
            expect(tail).not.toContain('User-declared ideal_outcome');
        });
    });
});
