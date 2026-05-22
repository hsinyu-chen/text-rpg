import { describe, expect, it } from 'vitest';
import type { SaveHunk } from '../multi-agent-save.types';
import {
    applyInventoryReview,
    parseCommitArgs,
    type CommitInventoryReviewArgs,
    type InventoryReviewFiles,
} from './inventory-review-tool';
import type { NewHunk } from '../utils/hunk-id.util';

const INV = '9.物品欄.md';
const ASSETS = '4.資產.md';
const TECH = '5.科技裝備.md';
const WORLD = '6.勢力與世界.md';
const OTHER = '3.人物狀態.md';

const FILES: InventoryReviewFiles = {
    inventoryFile: INV,
    assetsFile: ASSETS,
    techEquipmentFile: TECH,
    worldFactionsFile: WORLD,
};

function hunk(id: string, file: string, extra: Partial<SaveHunk> = {}): SaveHunk {
    return { id, file, context: '', replacement: 'x', ...extra };
}

function newHunk(file: string, extra: Partial<NewHunk> = {}): NewHunk {
    return { file, context: '', replacement: 'y', ...extra };
}

describe('parseCommitArgs', () => {
    it('defaults every field on a null / non-object payload', () => {
        const a = parseCommitArgs(null);
        expect(a).toEqual({ dropHunkIds: [], reviseHunks: [], newHunks: [], summary: '' });
        expect(parseCommitArgs('not an object')).toEqual(a);
        expect(parseCommitArgs(undefined)).toEqual(a);
    });

    it('parses a well-formed payload', () => {
        const raw = {
            dropHunkIds: ['H1', 'H2'],
            reviseHunks: [{ id: 'H3', file: INV, context: '', replacement: 'fixed' }],
            newHunks: [{ file: TECH, context: '## 新裝備', replacement: '- 詳細設定' }],
            summary: 'one drop, one fix, one new',
        };
        const a = parseCommitArgs(raw);
        expect(a.dropHunkIds).toEqual(['H1', 'H2']);
        expect(a.reviseHunks).toHaveLength(1);
        expect(a.reviseHunks[0]).toEqual({ id: 'H3', file: INV, context: '', replacement: 'fixed' });
        expect(a.newHunks).toHaveLength(1);
        expect(a.summary).toBe('one drop, one fix, one new');
    });

    it('drops non-string elements from dropHunkIds', () => {
        const a = parseCommitArgs({ dropHunkIds: ['H1', 42, null, 'H2'], reviseHunks: [], newHunks: [], summary: '' });
        expect(a.dropHunkIds).toEqual(['H1', 'H2']);
    });

    it('drops reviseHunks entries that lack an id or required hunk fields', () => {
        const a = parseCommitArgs({
            dropHunkIds: [],
            reviseHunks: [
                { id: 'H1', file: INV, context: '', replacement: 'ok' },
                { file: INV, context: '', replacement: 'no id' },           // missing id
                { id: 'H2', file: INV, context: '' },                        // missing replacement
                { id: 'H3', context: '', replacement: 'no file' },           // missing file
                'not even an object',
            ],
            newHunks: [],
            summary: '',
        });
        expect(a.reviseHunks).toHaveLength(1);
        expect(a.reviseHunks[0].id).toBe('H1');
    });

    it('drops newHunks entries that lack required fields', () => {
        const a = parseCommitArgs({
            dropHunkIds: [],
            reviseHunks: [],
            newHunks: [
                { file: TECH, context: '', replacement: 'ok' },
                { file: TECH, context: '' },                                  // missing replacement
                { context: '', replacement: 'no file' },                      // missing file
                { file: TECH, replacement: 'no context' },                    // missing context
            ],
            summary: '',
        });
        expect(a.newHunks).toHaveLength(1);
        expect(a.newHunks[0]).toEqual({ file: TECH, context: '', replacement: 'ok' });
    });

    it('keeps optional target + sourceMessageIds when present and well-typed', () => {
        const a = parseCommitArgs({
            dropHunkIds: [],
            reviseHunks: [{
                id: 'H1', file: INV, context: '', replacement: 'r',
                target: 'old', sourceMessageIds: ['m1', 'm2'],
            }],
            newHunks: [{
                file: TECH, context: '', replacement: 'r',
                target: 'old', sourceMessageIds: ['m3'],
            }],
            summary: 's',
        });
        expect(a.reviseHunks[0].target).toBe('old');
        expect(a.reviseHunks[0].sourceMessageIds).toEqual(['m1', 'm2']);
        expect(a.newHunks[0].target).toBe('old');
        expect(a.newHunks[0].sourceMessageIds).toEqual(['m3']);
    });

    it('coerces non-string summary to empty string', () => {
        expect(parseCommitArgs({ summary: 42 }).summary).toBe('');
    });
});

describe('applyInventoryReview', () => {
    function empty(): CommitInventoryReviewArgs {
        return { dropHunkIds: [], reviseHunks: [], newHunks: [], summary: '' };
    }

    it('returns the manifest unchanged on an empty delta', () => {
        const input = [hunk('H1', INV), hunk('H2', INV), hunk('H3', OTHER)];
        const { hunks, warnings } = applyInventoryReview(input, empty(), FILES);
        expect(hunks.map(h => h.id)).toEqual(['H1', 'H2', 'H3']);
        expect(warnings).toEqual([]);
    });

    it('drops an inventory hunk by id', () => {
        const input = [hunk('H1', INV), hunk('H2', INV)];
        const { hunks } = applyInventoryReview(input, { ...empty(), dropHunkIds: ['H1'] }, FILES);
        expect(hunks.map(h => h.id)).toEqual(['H2']);
    });

    it('drops an assets hunk by id (Job 1 also covers ASSETS)', () => {
        const input = [hunk('H1', ASSETS), hunk('H2', INV)];
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), dropHunkIds: ['H1'] }, FILES,
        );
        expect(hunks.map(h => h.id)).toEqual(['H2']);
        expect(warnings).toEqual([]);
    });

    it('warns and keeps when drop targets a hunk outside the drop scope (e.g. tech-equipment)', () => {
        const input = [hunk('H1', TECH, { replacement: 'untouched' })];
        // drop scope is INV + ASSETS only — revise/new allow TECH, drop does not.
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), dropHunkIds: ['H1'] }, FILES,
        );
        expect(hunks).toHaveLength(1);
        expect(warnings.join(' ')).toMatch(/outside this agent's drop scope/);
    });

    it('warns when drop references an unknown id', () => {
        const input = [hunk('H1', INV)];
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), dropHunkIds: ['H9'] }, FILES,
        );
        expect(hunks).toHaveLength(1);
        expect(warnings.join(' ')).toMatch(/unknown hunk id/);
    });

    it('revises an inventory hunk while preserving its id and position', () => {
        const input = [hunk('H1', INV), hunk('H2', INV, { replacement: 'original' }), hunk('H3', INV)];
        const fix = { id: 'H2', file: INV, context: 'x', replacement: 'corrected' };
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), reviseHunks: [fix] }, FILES,
        );
        expect(hunks.map(h => h.id)).toEqual(['H1', 'H2', 'H3']);
        expect(hunks[1].replacement).toBe('corrected');
        expect(hunks[1].context).toBe('x');
        expect(warnings).toEqual([]);
    });

    it('allows revising an assets hunk (Job 1 corrections)', () => {
        const input = [hunk('H1', ASSETS, { replacement: '-100G' })];
        const fix = { id: 'H1', file: ASSETS, context: '', replacement: '-50G' };
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), reviseHunks: [fix] }, FILES,
        );
        expect(hunks[0].replacement).toBe('-50G');
        expect(warnings).toEqual([]);
    });

    it('allows revising a tech-equipment hunk (Job 2 overlap with main LLM)', () => {
        const input = [hunk('H1', TECH, { replacement: 'main LLM original' })];
        const fix = { id: 'H1', file: TECH, context: '', replacement: 'agent improved' };
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), reviseHunks: [fix] }, FILES,
        );
        expect(hunks[0].replacement).toBe('agent improved');
        expect(warnings).toEqual([]);
    });

    it('allows revising a world-factions hunk (Job 2 overlap; prompt scopes to item entries)', () => {
        const input = [hunk('H1', WORLD, { replacement: 'main LLM key-item entry' })];
        const fix = { id: 'H1', file: WORLD, context: '', replacement: 'agent deepened lore' };
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), reviseHunks: [fix] }, FILES,
        );
        expect(hunks[0].replacement).toBe('agent deepened lore');
        expect(warnings).toEqual([]);
    });

    it('warns and keeps when revise targets a hunk outside the agent revise scope', () => {
        const input = [hunk('H1', OTHER, { replacement: 'untouched' })];
        const fix = { id: 'H1', file: OTHER, context: '', replacement: 'rewritten' };
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), reviseHunks: [fix] }, FILES,
        );
        expect(hunks[0].replacement).toBe('untouched');
        expect(warnings.join(' ')).toMatch(/outside this agent's revise scope/);
    });

    it('warns when revise tries to move a hunk to a different file', () => {
        const input = [hunk('H1', INV, { replacement: 'orig' })];
        const fix = { id: 'H1', file: TECH, context: '', replacement: 'moved' };
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), reviseHunks: [fix] }, FILES,
        );
        expect(hunks[0].file).toBe(INV);
        expect(hunks[0].replacement).toBe('orig');
        expect(warnings.join(' ')).toMatch(/cannot move/);
    });

    it('appends new tech-equipment hunks with stamped ids continuing past the input', () => {
        const input = [hunk('H1', INV), hunk('H2', INV)];
        const fresh = [
            newHunk(TECH, { context: '## 玄鐵令', replacement: '- 神兵閣信物' }),
            newHunk(TECH, { context: '## 火槍', replacement: '- 新研發武器' }),
        ];
        const { hunks } = applyInventoryReview(input, { ...empty(), newHunks: fresh }, FILES);
        expect(hunks).toHaveLength(4);
        // Original ids kept, new ids continue past input length (H3, H4).
        expect(hunks.map(h => h.id)).toEqual(['H1', 'H2', 'H3', 'H4']);
        expect(hunks[2].file).toBe(TECH);
    });

    it('appends new world-factions hunks (non-PC key items)', () => {
        const input = [hunk('H1', INV)];
        const fresh = [newHunk(WORLD, { context: '## 古劍·遺物', replacement: '- 守墓人遺物' })];
        const { hunks, warnings } = applyInventoryReview(
            input, { ...empty(), newHunks: fresh }, FILES,
        );
        expect(hunks).toHaveLength(2);
        expect(hunks[1].file).toBe(WORLD);
        expect(warnings).toEqual([]);
    });

    it('warns and rejects a new hunk targeting any file outside tech-equipment / world-factions', () => {
        const input = [hunk('H1', INV)];
        // Inventory and assets are NOT in the `new` scope (they only allow drop/revise).
        const fresh = [newHunk(INV), newHunk(ASSETS), newHunk(OTHER)];
        const { hunks, warnings } = applyInventoryReview(input, { ...empty(), newHunks: fresh }, FILES);
        expect(hunks).toHaveLength(1);
        expect(warnings).toHaveLength(3);
    });

    it('combines drop + revise + new in one delta', () => {
        const input = [hunk('H1', INV), hunk('H2', INV, { replacement: 'bad' }), hunk('H3', INV)];
        const args: CommitInventoryReviewArgs = {
            dropHunkIds: ['H1'],
            reviseHunks: [{ id: 'H2', file: INV, context: '', replacement: 'good' }],
            newHunks: [newHunk(TECH, { context: '## 新物品', replacement: '- 設定' })],
            summary: 's',
        };
        const { hunks } = applyInventoryReview(input, args, FILES);
        expect(hunks.map(h => h.id)).toEqual(['H2', 'H3', 'H4']);
        expect(hunks.find(h => h.id === 'H2')?.replacement).toBe('good');
        expect(hunks.find(h => h.id === 'H4')?.file).toBe(TECH);
    });
});
