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

    it('does NOT validate adds against KB (multiple adds with same title pass through)', () => {
        // Sub-1 scope: only remove is reconciled. dup-add merging is deferred.
        const result = cFixPlans(
            [
                { op: 'add', title: '奪回神兵', body: 'duplicate of existing' },
                { op: 'add', title: '奪回神兵', body: 'another duplicate' },
            ],
            PLAN_KB,
        );
        expect(result.deltas).toHaveLength(2);
        expect(result.fixes).toEqual([]);
    });
});
