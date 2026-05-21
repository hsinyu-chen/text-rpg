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

    describe('KB reconciliation', () => {
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

        it('converts add with details to update when item already in KB', () => {
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

        it('drops bare add (no details) against existing item to avoid clobbering description', () => {
            // Regression: convert-to-update with undefined details renders bare
            // `- X`, replacing the existing line and destroying the prior
            // description. Treat null-intent "ensure exists" against existing
            // row as a drop.
            const result = cFixInventory(
                [{ op: 'add', item: '玄鐵令' }],
                '- 玄鐵令 — 舊描述',
                LABEL,
            );
            expect(result.deltas).toEqual([]);
            expect(result.fixes[0]).toMatchObject({
                domain: 'inventory',
                kind: 'dropped-redundant-add',
            });
        });

        it('keeps bare add (no details) when item is genuinely new', () => {
            const result = cFixInventory(
                [{ op: 'add', item: '新刀' }],
                '- 別的東西',
                LABEL,
            );
            expect(result.deltas).toEqual([{ op: 'add', item: '新刀' }]);
            expect(result.fixes).toEqual([]);
        });

        it('drops delta with empty item name', () => {
            const result = cFixInventory([{ op: 'add', item: '' }], '', LABEL);
            expect(result.deltas).toEqual([]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-empty-item' });
        });
    });

    describe('same-item dedupe (dedup-first, keep last regardless of op)', () => {
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
                // last op (add) wins dedupe; KB recon converts add→update since
                // 短刀 is in KB → single replace hunk, no anchor conflict.
                { op: 'update', item: '短刀', details: '新撿到的' },
            ]);
            expect(result.fixes.some(f => f.kind === 'dropped-stale-dup-item')).toBe(true);
        });

        it('collapses [add X, remove X] cancellation to single remove (item in KB)', () => {
            const result = cFixInventory(
                [
                    { op: 'add', item: 'X', details: 'A' },
                    { op: 'remove', item: 'X' },
                ],
                '- X — 既有',
                LABEL,
            );
            expect(result.deltas).toEqual([{ op: 'remove', item: 'X' }]);
        });

        it('collapses [add X, remove X] cancellation to empty when item NOT in KB (no phantom add)', () => {
            // Regression: with KB-first ordering, `remove X` was dropped
            // (nothing to remove) and `add X` slipped through as a phantom
            // addition. Dedup-first collapses to `remove X` first, then KB
            // recon drops it for missing — net result: nothing, matching the
            // LLM's net intent ("I added it then removed it").
            const result = cFixInventory(
                [
                    { op: 'add', item: 'X', details: 'A' },
                    { op: 'remove', item: 'X' },
                ],
                '',
                LABEL,
            );
            expect(result.deltas).toEqual([]);
            expect(result.fixes.some(f => f.kind === 'dropped-stale-dup-item')).toBe(true);
            expect(result.fixes.some(f => f.kind === 'dropped-missing-remove')).toBe(true);
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
        it('handles update of missing item then dup add (dedupe + KB recon interplay)', () => {
            // Dedupe: two ops on X, keep last (add X (B)).
            // KB recon: empty file, X is new → stays add.
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
