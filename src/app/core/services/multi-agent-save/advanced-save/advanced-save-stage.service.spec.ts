import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AdvancedSaveStageService, type AdvancedSaveStageContext } from './advanced-save-stage.service';
import { ADVANCED_SAVE_AGENT, type AdvancedSaveAgent, type AdvancedSaveAgentInput } from './advanced-save-agent';
import { KVStore } from '../../kv/kv-store';
import { InMemoryKVStore } from '../../../testing/in-memory-kv-store';
import type { SaveHunk } from '../multi-agent-save.types';

/** A recording fake agent. `transform` shapes its output; default = passthrough. */
function fakeAgent(
    id: string,
    transform: (hunks: SaveHunk[]) => SaveHunk[] = h => h,
): AdvancedSaveAgent & { calls: AdvancedSaveAgentInput[] } {
    const calls: AdvancedSaveAgentInput[] = [];
    return {
        id,
        i18nKey: `test.${id}`,
        calls,
        async process(input) {
            calls.push(input);
            return transform(input.hunks);
        },
    };
}

function hunk(file: string, id = 'H0'): SaveHunk {
    return { id, file, context: [], replacement: 'x' };
}

/** Shared turn context — every field of the agent input except `hunks`. */
function ctx(signal: AbortSignal): AdvancedSaveStageContext {
    return { signal, files: new Map(), chatMessages: [], lang: 'default' };
}

/** Seeds `enabledSaveAgents` into KV as the store's constructor expects. */
function enabledSeed(...ids: string[]): Record<string, string> {
    return ids.length ? { mas_enabled_save_agents: JSON.stringify(ids) } : {};
}

function setup(
    agents: AdvancedSaveAgent[],
    enabled: string[],
): AdvancedSaveStageService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            { provide: KVStore, useValue: new InMemoryKVStore(enabledSeed(...enabled)) },
            ...agents.map(a => ({ provide: ADVANCED_SAVE_AGENT, useValue: a, multi: true })),
        ],
    });
    return TestBed.inject(AdvancedSaveStageService);
}

describe('AdvancedSaveStageService', () => {
    const signal = new AbortController().signal;

    it('is an identity pass when no agent is registered', async () => {
        const stage = setup([], []);
        const hunks = [hunk('a.md')];
        expect(await stage.process(hunks, ctx(signal))).toBe(hunks);
    });

    it('is an identity pass when agents exist but none are enabled', async () => {
        const a = fakeAgent('a');
        const stage = setup([a], []);
        const hunks = [hunk('a.md')];
        expect(await stage.process(hunks, ctx(signal))).toBe(hunks);
        expect(a.calls).toHaveLength(0);
    });

    it('runs only enabled agents', async () => {
        const a = fakeAgent('a');
        const b = fakeAgent('b');
        const stage = setup([a, b], ['b']);
        await stage.process([hunk('x.md')], ctx(signal));
        expect(a.calls).toHaveLength(0);
        expect(b.calls).toHaveLength(1);
    });

    it('threads the shared turn context into every agent call', async () => {
        const a = fakeAgent('a');
        const stage = setup([a], ['a']);
        const files = new Map([['9.物品欄.md', '- 長劍']]);
        await stage.process([hunk('x.md')], { signal, files, chatMessages: [], lang: 'zh-tw' });
        expect(a.calls[0].files).toBe(files);
        expect(a.calls[0].lang).toBe('zh-tw');
    });

    it('chains enabled agents in registration order, threading each output forward', async () => {
        const order: string[] = [];
        const a = fakeAgent('a', hunks => {
            order.push('a');
            return [...hunks, hunk('from-a.md')];
        });
        const b = fakeAgent('b', hunks => {
            order.push('b');
            return [...hunks, hunk('from-b.md')];
        });
        const stage = setup([a, b], ['a', 'b']);
        const result = await stage.process([hunk('seed.md')], ctx(signal));

        expect(order).toEqual(['a', 'b']);
        // b sees a's appended hunk on its input.
        expect(b.calls[0].hunks.map(h => h.file)).toEqual(['seed.md', 'from-a.md']);
        expect(result.map(h => h.file)).toEqual(['seed.md', 'from-a.md', 'from-b.md']);
    });

    it('skips a disabled agent mid-chain without disturbing the rest of the order', async () => {
        const order: string[] = [];
        const a = fakeAgent('a', h => { order.push('a'); return h; });
        const b = fakeAgent('b', h => { order.push('b'); return h; });
        const c = fakeAgent('c', h => { order.push('c'); return h; });
        const stage = setup([a, b, c], ['a', 'c']);
        await stage.process([hunk('x.md')], ctx(signal));
        expect(order).toEqual(['a', 'c']);
    });

    it('aborts the chain when the signal trips between agents', async () => {
        const controller = new AbortController();
        // `a` cancels the run as it finishes; the next agent must not start.
        const a = fakeAgent('a', hunks => { controller.abort(); return hunks; });
        const b = fakeAgent('b');
        const stage = setup([a, b], ['a', 'b']);
        await expect(stage.process([hunk('x.md')], ctx(controller.signal))).rejects.toThrow();
        expect(a.calls).toHaveLength(1);
        expect(b.calls).toHaveLength(0);
    });
});
