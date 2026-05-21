import { describe, expect, it } from 'vitest';
import type { InventoryDelta } from '../multi-agent-save.types';
import { cFixInventory } from './c-fix-inventory';

const LABEL = 'inventoryDeltas';

describe('cFixInventory', () => {
    it('returns empty for empty input', () => {
        expect(cFixInventory([], '', LABEL)).toEqual({ deltas: [], fixes: [] });
    });

    it('passes clean deltas through unchanged', () => {
        const deltas: InventoryDelta[] = [
            { op: 'add', item: '新刀', details: '隨身配劍' },
            { op: 'remove', item: '舊弓' },
        ];
        const file = '- 舊弓 — 已壞';
        const result = cFixInventory(deltas, file, LABEL);
        expect(result.deltas).toEqual(deltas);
        expect(result.fixes).toEqual([]);
    });

    it('threads fieldLabel into trace reasons (assetsDeltas vs inventoryDeltas)', () => {
        const result = cFixInventory(
            [{ op: 'remove', item: '不存在' }],
            '',
            'assetsDeltas',
        );
        expect(result.fixes[0].reason).toContain('assetsDeltas');
    });

    describe('pass 1 — KB reconciliation', () => {
        it('drops remove for item not in KB', () => {
            const result = cFixInventory(
                [{ op: 'remove', item: '不存在' }],
                '- 別的東西',
                LABEL,
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
                LABEL,
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
                LABEL,
            );
            expect(result.deltas).toEqual([
                { op: 'update', item: '玄鐵令', details: '神兵閣信物' },
            ]);
            expect(result.fixes[0]).toMatchObject({
                domain: 'inventory',
                kind: 'add-merged-to-update',
            });
        });

        it('drops delta with empty item name', () => {
            const result = cFixInventory([{ op: 'add', item: '' }], '', LABEL);
            expect(result.deltas).toEqual([]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-empty-item' });
        });
    });

    describe('pass 2 — same-item dedupe (regardless of op)', () => {
        it('drops earlier dup adds, keeps the last (LLM repeated 玄鐵令 × 3)', () => {
            const result = cFixInventory(
                [
                    { op: 'add', item: '玄鐵令', details: 'A' },
                    { op: 'add', item: '玄鐵令', details: 'B' },
                    { op: 'add', item: '玄鐵令', details: 'C' },
                ],
                '',
                LABEL,
            );
            expect(result.deltas).toEqual([
                { op: 'add', item: '玄鐵令', details: 'C' },
            ]);
            const dupFixes = result.fixes.filter(f => f.kind === 'dropped-stale-dup-item');
            expect(dupFixes).toHaveLength(2);
        });

        it('collapses [remove X, add X] for existing item to single update (avoids handler anchor-conflict)', () => {
            // Regression: previously this stayed as [remove X, update X]
            // (different ops, no dedup), and the handler emitted delete +
            // replace both targeting the same line — replace would fail on
            // apply ("target not found"), losing the item.
            const result = cFixInventory(
                [
                    { op: 'remove', item: '短刀' },
                    { op: 'add', item: '短刀', details: '新撿到的' },
                ],
                '- 短刀 — 舊的',
                LABEL,
            );
            expect(result.deltas).toEqual([
                // last op (add) wins dedupe; pass 1 converts add→update since
                // 短刀 is in KB → single replace hunk, no anchor conflict.
                { op: 'update', item: '短刀', details: '新撿到的' },
            ]);
            expect(result.fixes.some(f => f.kind === 'dropped-stale-dup-item')).toBe(true);
        });

        it('collapses [add X, remove X] cancellation to single remove', () => {
            const result = cFixInventory(
                [
                    { op: 'add', item: 'X', details: 'A' },
                    { op: 'remove', item: 'X' },
                ],
                '- X — 既有',
                LABEL,
            );
            // remove wins (last); item in KB so remove survives pass 1.
            expect(result.deltas).toEqual([{ op: 'remove', item: 'X' }]);
        });

        it('keeps last update when LLM updates the same item twice', () => {
            const result = cFixInventory(
                [
                    { op: 'update', item: '玄鐵令', details: '舊狀態' },
                    { op: 'update', item: '玄鐵令', details: '新狀態' },
                ],
                '- 玄鐵令 — 原描述',
                LABEL,
            );
            expect(result.deltas).toEqual([
                { op: 'update', item: '玄鐵令', details: '新狀態' },
            ]);
        });

        it('does NOT dedupe different items', () => {
            const result = cFixInventory(
                [
                    { op: 'add', item: 'X', details: 'a' },
                    { op: 'add', item: 'Y', details: 'b' },
                ],
                '',
                LABEL,
            );
            expect(result.deltas).toHaveLength(2);
            expect(result.fixes).toEqual([]);
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
                LABEL,
            );
            expect(result.deltas).toEqual([{ op: 'add', item: 'X', details: 'B' }]);
        });
    });
});
