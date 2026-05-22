import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AdvancedSaveStageService } from './advanced-save-stage.service';
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

function hunk(file: string): SaveHunk {
    return { file, context: '', replacement: 'x' };
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
        expect(await stage.process(hunks, signal)).toBe(hunks);
    });

    it('is an identity pass when agents exist but none are enabled', async () => {
        const a = fakeAgent('a');
        const stage = setup([a], []);
        const hunks = [hunk('a.md')];
        expect(await stage.process(hunks, signal)).toBe(hunks);
        expect(a.calls).toHaveLength(0);
    });

    it('runs only enabled agents', async () => {
        const a = fakeAgent('a');
        const b = fakeAgent('b');
        const stage = setup([a, b], ['b']);
        await stage.process([hunk('x.md')], signal);
        expect(a.calls).toHaveLength(0);
        expect(b.calls).toHaveLength(1);
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
        const result = await stage.process([hunk('seed.md')], signal);

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
        await stage.process([hunk('x.md')], signal);
        expect(order).toEqual(['a', 'c']);
    });
});
