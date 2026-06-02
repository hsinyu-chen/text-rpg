import { describe, expect, it } from 'vitest';
import type { SaveHunk } from '../../multi-agent-save.types';
import type { NewHunk } from '../../utils/hunk-id.util';
import {
    applyEntityStateReview,
    parseCommitEntityStateArgs,
    parseReportNotAnEntityArgs,
    type CommitEntityStateReviewArgs,
    type EntityStateReviewScope,
} from './entity-state-review-tool';

const CHAR = '3.人物狀態.md';
const OTHER = '9.物品欄.md';
const LUNA = '露娜 (Luna)';
const RAVEN = '冷鴉';

const SCOPE: EntityStateReviewScope = {
    targetFile: CHAR,
    currentEntityName: LUNA,
    knownEntityNames: new Set([LUNA, RAVEN]),
};

function hunk(id: string, file: string, extra: Partial<SaveHunk> = {}): SaveHunk {
    return { id, file, context: ['核心人物', LUNA], replacement: 'x', ...extra };
}

function newHunk(file: string, extra: Partial<NewHunk> = {}): NewHunk {
    return { file, context: ['核心人物', LUNA], replacement: 'y', ...extra };
}

function empty(): CommitEntityStateReviewArgs {
    return { dropHunkIds: [], reviseHunks: [], newHunks: [], summary: '' };
}

describe('parseCommitEntityStateArgs', () => {
    it('defaults every field on a null / non-object payload', () => {
        const a = parseCommitEntityStateArgs(null);
        expect(a).toEqual({ dropHunkIds: [], reviseHunks: [], newHunks: [], summary: '' });
        expect(parseCommitEntityStateArgs('nope')).toEqual(a);
        expect(parseCommitEntityStateArgs(undefined)).toEqual(a);
    });

    it('parses a well-formed payload', () => {
        const a = parseCommitEntityStateArgs({
            dropHunkIds: ['H1'],
            reviseHunks: [{ id: 'H2', file: CHAR, context: ['核心人物', LUNA], replacement: 'fixed' }],
            newHunks: [{ file: CHAR, context: ['核心人物', LUNA, '現況'], replacement: '- 養傷中' }],
            summary: 's',
        });
        expect(a.dropHunkIds).toEqual(['H1']);
        expect(a.reviseHunks).toHaveLength(1);
        expect(a.reviseHunks[0].id).toBe('H2');
        expect(a.newHunks).toHaveLength(1);
        expect(a.summary).toBe('s');
    });

    it('keeps optional perception annotations when present and well-typed', () => {
        const a = parseCommitEntityStateArgs({
            dropHunkIds: [],
            reviseHunks: [{
                id: 'H1', file: CHAR, context: ['核心人物', LUNA], replacement: 'r',
                perceptionLevel: 'medium', perceptionReason: '同伴轉述',
            }],
            newHunks: [{
                file: CHAR, context: ['核心人物', LUNA], replacement: 'n',
                perceptionLevel: 'weak', perceptionReason: '感應方向',
            }],
            summary: 's',
        });
        expect(a.reviseHunks[0].perceptionLevel).toBe('medium');
        expect(a.reviseHunks[0].perceptionReason).toBe('同伴轉述');
        expect(a.newHunks[0].perceptionLevel).toBe('weak');
    });

    it('drops an invalid perceptionLevel rather than keeping it', () => {
        const a = parseCommitEntityStateArgs({
            dropHunkIds: [],
            reviseHunks: [{ id: 'H1', file: CHAR, context: [LUNA], replacement: 'r', perceptionLevel: 'certain' }],
            newHunks: [],
            summary: '',
        });
        expect(a.reviseHunks[0].perceptionLevel).toBeUndefined();
    });

    it('drops malformed array entries', () => {
        const a = parseCommitEntityStateArgs({
            dropHunkIds: ['H1', 42, null],
            reviseHunks: [
                { id: 'H1', file: CHAR, context: [LUNA], replacement: 'ok' },
                { file: CHAR, context: [LUNA], replacement: 'no id' },
                'not an object',
            ],
            newHunks: [{ file: CHAR, replacement: 'no context' }],
            summary: 42,
        });
        expect(a.dropHunkIds).toEqual(['H1']);
        expect(a.reviseHunks).toHaveLength(1);
        expect(a.newHunks).toHaveLength(0);
        expect(a.summary).toBe('');
    });
});

describe('parseReportNotAnEntityArgs', () => {
    it('defaults both fields on a null payload', () => {
        expect(parseReportNotAnEntityArgs(null)).toEqual({ entityName: '', reason: '' });
    });

    it('parses a well-formed payload', () => {
        const a = parseReportNotAnEntityArgs({ entityName: '範例角色格式', reason: 'format template' });
        expect(a).toEqual({ entityName: '範例角色格式', reason: 'format template' });
    });

    it('coerces non-string fields to empty strings', () => {
        expect(parseReportNotAnEntityArgs({ entityName: 1, reason: {} })).toEqual({ entityName: '', reason: '' });
    });
});

describe('applyEntityStateReview', () => {
    it('returns the manifest unchanged on an empty delta', () => {
        const input = [hunk('H1', CHAR), hunk('H2', CHAR)];
        const { hunks, warnings } = applyEntityStateReview(input, empty(), SCOPE, new Set());
        expect(hunks.map(h => h.id)).toEqual(['H1', 'H2']);
        expect(warnings).toEqual([]);
    });

    it('drops a hunk on the target file by id', () => {
        const input = [hunk('H1', CHAR), hunk('H2', CHAR)];
        const { hunks } = applyEntityStateReview(input, { ...empty(), dropHunkIds: ['H1'] }, SCOPE, new Set());
        expect(hunks.map(h => h.id)).toEqual(['H2']);
    });

    it('warns and keeps when drop targets a hunk on another file', () => {
        const input = [hunk('H1', OTHER)];
        const { hunks, warnings } = applyEntityStateReview(input, { ...empty(), dropHunkIds: ['H1'] }, SCOPE, new Set());
        expect(hunks).toHaveLength(1);
        expect(warnings.join(' ')).toMatch(/outside this agent's file/);
    });

    it('warns when drop references an unknown id', () => {
        const input = [hunk('H1', CHAR)];
        const { hunks, warnings } = applyEntityStateReview(input, { ...empty(), dropHunkIds: ['H9'] }, SCOPE, new Set());
        expect(hunks).toHaveLength(1);
        expect(warnings.join(' ')).toMatch(/unknown hunk id/);
    });

    it('revises a hunk inside the current entity, preserving id and position', () => {
        const input = [hunk('H1', CHAR), hunk('H2', CHAR, { replacement: 'orig' }), hunk('H3', CHAR)];
        const fix = { id: 'H2', file: CHAR, context: ['核心人物', LUNA, '現況'], replacement: 'fixed' };
        const { hunks, warnings } = applyEntityStateReview(input, { ...empty(), reviseHunks: [fix] }, SCOPE, new Set());
        expect(hunks.map(h => h.id)).toEqual(['H1', 'H2', 'H3']);
        expect(hunks[1].replacement).toBe('fixed');
        expect(warnings).toEqual([]);
    });

    it('revise merges over the original so omitted target / sourceMessageIds survive', () => {
        const input = [hunk('H1', CHAR, { target: '- 重傷', replacement: 'wrong', sourceMessageIds: ['m1'] })];
        const fix = { id: 'H1', file: CHAR, context: ['核心人物', LUNA], replacement: 'fixed' };
        const { hunks } = applyEntityStateReview(input, { ...empty(), reviseHunks: [fix] }, SCOPE, new Set(['m1']));
        expect(hunks[0].replacement).toBe('fixed');
        expect(hunks[0].target).toBe('- 重傷');
        expect(hunks[0].sourceMessageIds).toEqual(['m1']);
    });

    it('strips trace-only perception fields before merging into the manifest', () => {
        const input = [hunk('H1', CHAR, { replacement: 'orig' })];
        const fix = {
            id: 'H1', file: CHAR, context: ['核心人物', LUNA], replacement: 'fixed',
            perceptionLevel: 'strong' as const, perceptionReason: '親眼所見',
        };
        const { hunks } = applyEntityStateReview(input, { ...empty(), reviseHunks: [fix] }, SCOPE, new Set());
        expect(hunks[0]).not.toHaveProperty('perceptionLevel');
        expect(hunks[0]).not.toHaveProperty('perceptionReason');
    });

    it('warns and keeps when revise targets a hunk outside the entity section', () => {
        const input = [hunk('H1', CHAR, { context: ['核心人物', RAVEN], replacement: 'raven' })];
        const fix = { id: 'H1', file: CHAR, context: ['核心人物', RAVEN], replacement: 'rewritten' };
        const { hunks, warnings } = applyEntityStateReview(input, { ...empty(), reviseHunks: [fix] }, SCOPE, new Set());
        expect(hunks[0].replacement).toBe('raven');
        expect(warnings.join(' ')).toMatch(/not inside entity/);
    });

    it('warns when revise tries to move a hunk to a different file', () => {
        const input = [hunk('H1', CHAR, { replacement: 'orig' })];
        const fix = { id: 'H1', file: OTHER, context: ['核心人物', LUNA], replacement: 'moved' };
        const { hunks, warnings } = applyEntityStateReview(input, { ...empty(), reviseHunks: [fix] }, SCOPE, new Set());
        expect(hunks[0].file).toBe(CHAR);
        expect(hunks[0].replacement).toBe('orig');
        expect(warnings.join(' ')).toMatch(/cannot move/);
    });

    it('appends new hunks inside a known entity with ids continuing past the input', () => {
        const input = [hunk('H1', CHAR), hunk('H2', CHAR)];
        const fresh = [
            newHunk(CHAR, { context: ['核心人物', LUNA, '現況'], replacement: '- 養傷中' }),
            newHunk(CHAR, { context: ['核心人物', RAVEN], replacement: '- off-screen 計畫' }),
        ];
        const { hunks, warnings } = applyEntityStateReview(input, { ...empty(), newHunks: fresh }, SCOPE, new Set());
        expect(hunks.map(h => h.id)).toEqual(['H1', 'H2', 'H3', 'H4']);
        expect(warnings).toEqual([]);
    });

    it('warns and rejects a new hunk on another file', () => {
        const input = [hunk('H1', CHAR)];
        const fresh = [newHunk(OTHER, { context: ['核心人物', LUNA] })];
        const { hunks, warnings } = applyEntityStateReview(input, { ...empty(), newHunks: fresh }, SCOPE, new Set());
        expect(hunks).toHaveLength(1);
        expect(warnings.join(' ')).toMatch(/must target/);
    });

    it('warns and rejects a new hunk whose context matches no known entity', () => {
        const input = [hunk('H1', CHAR)];
        const fresh = [newHunk(CHAR, { context: ['核心人物', '全新幻覺角色'], replacement: '- 不存在' })];
        const { hunks, warnings } = applyEntityStateReview(input, { ...empty(), newHunks: fresh }, SCOPE, new Set());
        expect(hunks).toHaveLength(1);
        expect(warnings.join(' ')).toMatch(/does not match a known entity/);
    });

    it('stamps new-hunk ids past the manifest max, not its length (gap-safe)', () => {
        const input = [hunk('H1', CHAR), hunk('H3', CHAR)];
        const fresh = [newHunk(CHAR, { context: ['核心人物', LUNA] })];
        const { hunks } = applyEntityStateReview(input, { ...empty(), newHunks: fresh }, SCOPE, new Set());
        expect(hunks.map(h => h.id)).toEqual(['H1', 'H3', 'H4']);
    });

    it('drops fabricated sourceMessageIds from authored hunks and warns', () => {
        const input = [hunk('H1', CHAR, { replacement: 'orig' })];
        const fix = {
            id: 'H1', file: CHAR, context: ['核心人物', LUNA], replacement: 'fixed',
            sourceMessageIds: ['real', 'ghost'],
        };
        const { hunks, warnings } = applyEntityStateReview(
            input, { ...empty(), reviseHunks: [fix] }, SCOPE, new Set(['real']),
        );
        expect(hunks[0].sourceMessageIds).toEqual(['real']);
        expect(warnings.some(w => w.includes('"ghost"'))).toBe(true);
    });

    it('combines drop + revise + new in one delta', () => {
        const input = [hunk('H1', CHAR), hunk('H2', CHAR, { replacement: 'bad' }), hunk('H3', CHAR)];
        const args: CommitEntityStateReviewArgs = {
            dropHunkIds: ['H1'],
            reviseHunks: [{ id: 'H2', file: CHAR, context: ['核心人物', LUNA], replacement: 'good' }],
            newHunks: [newHunk(CHAR, { context: ['核心人物', LUNA, '現況'], replacement: '- 設定' })],
            summary: 's',
        };
        const { hunks } = applyEntityStateReview(input, args, SCOPE, new Set());
        expect(hunks.map(h => h.id)).toEqual(['H2', 'H3', 'H4']);
        expect(hunks.find(h => h.id === 'H2')?.replacement).toBe('good');
    });
});
