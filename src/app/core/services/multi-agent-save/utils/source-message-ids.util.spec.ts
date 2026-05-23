import { describe, it, expect } from 'vitest';
import { pruneInvalidSourceMessageIds } from './source-message-ids.util';
import type { SaveHunk } from '../multi-agent-save.types';

function hunk(over: Partial<SaveHunk>): SaveHunk {
    return {
        id: 'H1',
        file: 'inventory.md',
        context: '',
        replacement: '',
        ...over,
    };
}

describe('pruneInvalidSourceMessageIds', () => {
    it('keeps ids that exist in the valid set', () => {
        const hunks = [hunk({ id: 'H1', sourceMessageIds: ['m1', 'm2'] })];
        const result = pruneInvalidSourceMessageIds(hunks, new Set(['m1', 'm2', 'm3']));
        expect(result.hunks[0].sourceMessageIds).toEqual(['m1', 'm2']);
        expect(result.warnings).toEqual([]);
    });

    it('drops unknown ids and emits a warning naming them', () => {
        const hunks = [hunk({ id: 'H2', sourceMessageIds: ['real-msg', 'fake-msg', 'another-fake'] })];
        const result = pruneInvalidSourceMessageIds(hunks, new Set(['real-msg']));
        expect(result.hunks[0].sourceMessageIds).toEqual(['real-msg']);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('H2');
        expect(result.warnings[0]).toContain('"fake-msg"');
        expect(result.warnings[0]).toContain('"another-fake"');
    });

    it('preserves empty arrays (explicit "no anchors") without warning', () => {
        const hunks = [hunk({ id: 'H3', sourceMessageIds: [] })];
        const result = pruneInvalidSourceMessageIds(hunks, new Set());
        expect(result.hunks[0].sourceMessageIds).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    it('leaves omitted sourceMessageIds omitted', () => {
        const hunks = [hunk({ id: 'H4' })];
        const result = pruneInvalidSourceMessageIds(hunks, new Set());
        expect('sourceMessageIds' in result.hunks[0]).toBe(false);
        expect(result.warnings).toEqual([]);
    });

    it('never drops the hunk itself, even when all ids are bad', () => {
        const hunks = [hunk({ id: 'H5', sourceMessageIds: ['ghost1', 'ghost2'] })];
        const result = pruneInvalidSourceMessageIds(hunks, new Set());
        expect(result.hunks).toHaveLength(1);
        expect(result.hunks[0].id).toBe('H5');
        expect(result.hunks[0].sourceMessageIds).toEqual([]);
        expect(result.warnings).toHaveLength(1);
    });

    it('processes multiple hunks independently', () => {
        const hunks = [
            hunk({ id: 'H1', sourceMessageIds: ['ok', 'bad'] }),
            hunk({ id: 'H2', sourceMessageIds: ['ok'] }),
            hunk({ id: 'H3' }),
        ];
        const result = pruneInvalidSourceMessageIds(hunks, new Set(['ok']));
        expect(result.hunks[0].sourceMessageIds).toEqual(['ok']);
        expect(result.hunks[1].sourceMessageIds).toEqual(['ok']);
        expect('sourceMessageIds' in result.hunks[2]).toBe(false);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('H1');
    });
});
