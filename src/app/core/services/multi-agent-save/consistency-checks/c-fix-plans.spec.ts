import { describe, expect, it } from 'vitest';
import type { PlanDelta } from '../multi-agent-save.types';
import { cFixPlans } from './c-fix-plans';

const PLAN_KB = [
    '# 計畫',
    '',
    '## 「奪回神兵」計畫',
    '',
    '- **發起者**: 李四',
    '- 進度: 三成',
    '',
    '## 「結盟天劍門」計畫',
    '',
    '- **發起者**: 王五',
].join('\n');

describe('cFixPlans', () => {
    it('returns empty for empty input', () => {
        expect(cFixPlans([], '')).toEqual({ deltas: [], fixes: [] });
    });

    it('passes clean deltas through unchanged', () => {
        const deltas: PlanDelta[] = [
            { op: 'add', title: '新計畫', body: 'body' },
            { op: 'remove', title: '奪回神兵' },
        ];
        const result = cFixPlans(deltas, PLAN_KB);
        expect(result.deltas).toEqual(deltas);
        expect(result.fixes).toEqual([]);
    });

    describe('KB reconciliation', () => {
        it('drops remove for plan not in KB', () => {
            const result = cFixPlans(
                [{ op: 'remove', title: '不存在的計畫' }],
                PLAN_KB,
            );
            expect(result.deltas).toEqual([]);
            expect(result.fixes).toHaveLength(1);
            expect(result.fixes[0]).toMatchObject({
                domain: 'plans',
                kind: 'dropped-missing-remove',
            });
            expect(result.fixes[0].reason).toContain('不存在的計畫');
        });

        it('keeps remove for plan that IS in KB', () => {
            const result = cFixPlans(
                [{ op: 'remove', title: '奪回神兵' }],
                PLAN_KB,
            );
            expect(result.deltas).toEqual([{ op: 'remove', title: '奪回神兵' }]);
            expect(result.fixes).toEqual([]);
        });

        it('converts update to add when plan not in KB', () => {
            const result = cFixPlans(
                [{ op: 'update', title: '新計畫', body: '草案' }],
                PLAN_KB,
            );
            expect(result.deltas).toEqual([
                { op: 'add', title: '新計畫', body: '草案' },
            ]);
            expect(result.fixes[0]).toMatchObject({
                domain: 'plans',
                kind: 'update-fallback-to-add',
            });
        });

        it('converts add with body to update when plan already in KB (prevents duplicate L2 block)', () => {
            // Regression: handler `add` blindly appends, which would create a
            // duplicate `## Title` block and corrupt future lookupSectionBlock
            // calls. Convert to update so the existing block is replaced.
            const result = cFixPlans(
                [{ op: 'add', title: '奪回神兵', body: '新進度' }],
                PLAN_KB,
            );
            expect(result.deltas).toEqual([
                { op: 'update', title: '奪回神兵', body: '新進度' },
            ]);
            expect(result.fixes[0]).toMatchObject({
                domain: 'plans',
                kind: 'add-merged-to-update',
            });
        });

        it('drops bare add (no body) against existing plan to avoid clobbering body', () => {
            const result = cFixPlans(
                [{ op: 'add', title: '奪回神兵' }],
                PLAN_KB,
            );
            expect(result.deltas).toEqual([]);
            expect(result.fixes[0]).toMatchObject({
                domain: 'plans',
                kind: 'dropped-redundant-add',
            });
        });

        it('keeps bare add (no body) when plan is genuinely new', () => {
            const result = cFixPlans(
                [{ op: 'add', title: '全新計畫' }],
                PLAN_KB,
            );
            expect(result.deltas).toEqual([{ op: 'add', title: '全新計畫' }]);
            expect(result.fixes).toEqual([]);
        });

        it('accepts title with brackets / 計畫 suffix (model variant)', () => {
            // Model may emit title with or without the 「」 / 計畫 wrappers.
            // The shared derivePlanAtxPath helper normalizes all variants.
            const result = cFixPlans(
                [
                    { op: 'remove', title: '「奪回神兵」計畫' },
                    { op: 'remove', title: '結盟天劍門」' },
                ],
                PLAN_KB,
            );
            expect(result.deltas).toHaveLength(2);
            expect(result.fixes).toEqual([]);
        });

        it('drops delta with empty title', () => {
            const result = cFixPlans([{ op: 'add', title: '' }], '');
            expect(result.deltas).toEqual([]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-empty-title' });
        });

        it('uses "not found or ambiguous" reason for missing-remove (lookupSectionBlock conflates both)', () => {
            const result = cFixPlans(
                [{ op: 'remove', title: '不存在的計畫' }],
                PLAN_KB,
            );
            expect(result.fixes[0].reason).toContain('not found or ambiguous');
        });
    });

    describe('same-title dedupe (dedup-first, keep last regardless of op)', () => {
        it('collapses dup adds, keeps the last', () => {
            const result = cFixPlans(
                [
                    { op: 'add', title: '新計畫', body: 'A' },
                    { op: 'add', title: '新計畫', body: 'B' },
                ],
                PLAN_KB,
            );
            expect(result.deltas).toEqual([{ op: 'add', title: '新計畫', body: 'B' }]);
            expect(result.fixes.some(f => f.kind === 'dropped-stale-dup-title')).toBe(true);
        });

        it('collapses [remove P, update P] for existing plan to single update (avoids handler anchor-conflict)', () => {
            // Regression: previously both ops survived; handler emitted
            // delete + replace targeting the same L2 block, second hunk
            // failed on apply, plan was lost.
            const result = cFixPlans(
                [
                    { op: 'remove', title: '奪回神兵' },
                    { op: 'update', title: '奪回神兵', body: '新版本' },
                ],
                PLAN_KB,
            );
            expect(result.deltas).toEqual([
                { op: 'update', title: '奪回神兵', body: '新版本' },
            ]);
            expect(result.fixes.some(f => f.kind === 'dropped-stale-dup-title')).toBe(true);
        });

        it('collapses [add P, remove P] cancellation to empty when plan NOT in KB (no phantom add)', () => {
            // Regression: with KB-first ordering, `remove P` was dropped
            // (not in KB) and `add P` slipped through as a phantom addition.
            // Dedup-first collapses to `remove P` first, then KB recon drops
            // it — net result matches the LLM's net intent.
            const result = cFixPlans(
                [
                    { op: 'add', title: '草稿', body: 'A' },
                    { op: 'remove', title: '草稿' },
                ],
                PLAN_KB,
            );
            expect(result.deltas).toEqual([]);
            expect(result.fixes.some(f => f.kind === 'dropped-stale-dup-title')).toBe(true);
            expect(result.fixes.some(f => f.kind === 'dropped-missing-remove')).toBe(true);
        });

        it('does NOT dedupe different titles', () => {
            const result = cFixPlans(
                [
                    { op: 'add', title: 'A', body: 'a' },
                    { op: 'add', title: 'B', body: 'b' },
                ],
                PLAN_KB,
            );
            expect(result.deltas).toHaveLength(2);
            expect(result.fixes).toEqual([]);
        });
    });
});
