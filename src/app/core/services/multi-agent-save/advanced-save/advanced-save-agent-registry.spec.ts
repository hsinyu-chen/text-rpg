import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AdvancedSaveAgentRegistry } from './advanced-save-agent-registry';
import { ADVANCED_SAVE_AGENT, type AdvancedSaveAgent } from './advanced-save-agent';

function fakeAgent(id: string): AdvancedSaveAgent {
    return { id, i18nKey: `test.${id}`, process: async input => input.hunks };
}

describe('AdvancedSaveAgentRegistry', () => {
    it('resolves to an empty list when no agent is bound (Stage 2 baseline)', () => {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({});
        expect(TestBed.inject(AdvancedSaveAgentRegistry).all()).toEqual([]);
    });

    it('exposes bound agents in multi-provider declaration order', () => {
        TestBed.resetTestingModule();
        const first = fakeAgent('first');
        const second = fakeAgent('second');
        TestBed.configureTestingModule({
            providers: [
                { provide: ADVANCED_SAVE_AGENT, useValue: first, multi: true },
                { provide: ADVANCED_SAVE_AGENT, useValue: second, multi: true },
            ],
        });
        const all = TestBed.inject(AdvancedSaveAgentRegistry).all();
        expect(all.map(a => a.id)).toEqual(['first', 'second']);
    });
});
