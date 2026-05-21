import { describe, expect, it } from 'vitest';
import type { InventoryDelta } from '../multi-agent-save.types';
import { cFixInventory } from './c-fix-inventory';

describe('cFixInventory', () => {
    it('returns empty for empty input', () => {
        expect(cFixInventory([], '')).toEqual({ deltas: [], fixes: [] });
    });

    it('passes clean deltas through unchanged', () => {
        const deltas: InventoryDelta[] = [
            { op: 'add', item: '新刀', details: '隨身配劍' },
            { op: 'remove', item: '舊弓' },
        ];
        const file = '- 舊弓 — 已壞';
        const result = cFixInventory(deltas, file);
        expect(result.deltas).toEqual(deltas);
        expect(result.fixes).toEqual([]);
    });

    describe('pass 1 — KB reconciliation', () => {
        it('drops remove for item not in KB', () => {
            const result = cFixInventory(
                [{ op: 'remove', item: '不存在' }],
                '- 別的東西',
            );
            expect(result.deltas).toEqual([]);
            expect(result.fixes).toHaveLength(1);
            expect(result.fixes[0]).toMatchObject({
                domain: 'inventory',
                kind: 'dropped-missing-remove',
            });
            expect(result.fixes[0].reason).toContain('不存在');
        });

        it('converts update to add when item not in KB', () => {
            const result = cFixInventory(
                [{ op: 'update', item: '新物', details: '新狀態' }],
                '- 別的東西',
            );
            expect(result.deltas).toEqual([{ op: 'add', item: '新物', details: '新狀態' }]);
            expect(result.fixes[0]).toMatchObject({
                domain: 'inventory',
                kind: 'update-fallback-to-add',
            });
        });

        it('converts add to update when item already in KB', () => {
            const result = cFixInventory(
                [{ op: 'add', item: '玄鐵令', details: '神兵閣信物' }],
                '- 玄鐵令 — 舊描述',
            );
            expect(result.deltas).toEqual([
                { op: 'add', item: '玄鐵令', details: '神兵閣信物', /* op overridden below */ },
            ].map(d => ({ ...d, op: 'update' as const })));
            expect(result.fixes[0]).toMatchObject({
                domain: 'inventory',
                kind: 'add-merged-to-update',
            });
        });

        it('drops delta with empty item name', () => {
            const result = cFixInventory([{ op: 'add', item: '' }], '');
            expect(result.deltas).toEqual([]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-empty-item' });
        });
    });

    describe('pass 2 — same-op same-item dedupe', () => {
        it('drops earlier dup adds, keeps the last (LLM repeated 玄鐵令 × 3)', () => {
            const result = cFixInventory(
                [
                    { op: 'add', item: '玄鐵令', details: 'A' },
                    { op: 'add', item: '玄鐵令', details: 'B' },
                    { op: 'add', item: '玄鐵令', details: 'C' },
                ],
                '',
            );
            expect(result.deltas).toEqual([
                { op: 'add', item: '玄鐵令', details: 'C' },
            ]);
            // Two earlier adds dropped → two fixes of stale-dup kind.
            const dupFixes = result.fixes.filter(f => f.kind === 'dropped-stale-same-op-dup');
            expect(dupFixes).toHaveLength(2);
        });

        it('does NOT collapse different-op duplicates (remove + add cycle stays)', () => {
            const result = cFixInventory(
                [
                    { op: 'remove', item: '短刀' },
                    { op: 'add', item: '短刀', details: '新撿到的' },
                ],
                '- 短刀 — 舊的',
            );
            expect(result.deltas).toEqual([
                { op: 'remove', item: '短刀' },
                // add was converted to update by pass 1 (item still appears in KB).
                { op: 'update', item: '短刀', details: '新撿到的' },
            ]);
        });

        it('keeps last update when LLM updates the same item twice', () => {
            const result = cFixInventory(
                [
                    { op: 'update', item: '玄鐵令', details: '舊狀態' },
                    { op: 'update', item: '玄鐵令', details: '新狀態' },
                ],
                '- 玄鐵令 — 原描述',
            );
            expect(result.deltas).toEqual([
                { op: 'update', item: '玄鐵令', details: '新狀態' },
            ]);
        });
    });

    describe('combined cases', () => {
        it('handles update of missing item then dup add (pass 1 + pass 2 interplay)', () => {
            // Pass 1: update X (not in KB) → add X (A); add X (B) stays.
            // Pass 2: two adds for X, keep last (B).
            const result = cFixInventory(
                [
                    { op: 'update', item: 'X', details: 'A' },
                    { op: 'add', item: 'X', details: 'B' },
                ],
                '',
            );
            expect(result.deltas).toEqual([{ op: 'add', item: 'X', details: 'B' }]);
        });
    });
});
