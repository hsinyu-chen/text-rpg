import { describe, expect, it } from 'vitest';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type { SaveManifest } from '../multi-agent-save.types';
import { cFixLifecycle } from './c-fix-lifecycle';

const CHARACTERS_FILE = '3.人物狀態.md';
const FACTIONS_FILE = '6.勢力與世界.md';

const CHARACTERS_KB = [
    '# 核心人物',
    '',
    '## 李四',
    '- 身分: 劍士',
    '',
    '## 王五',
    '- 身分: 商人',
    '',
    '# 已故人物',
    '',
    '## 趙六 (Zhao Liu)',
    '- 身分: 過去的師父',
].join('\n');

const FACTIONS_KB = [
    '# 主要勢力',
    '',
    '## 天劍門',
    '- 風格: 正派',
].join('\n');

const coreFilenames: AppLocale['coreFilenames'] = {
    CHARACTER_STATUS: CHARACTERS_FILE,
    WORLD_FACTIONS: FACTIONS_FILE,
    // Other fields aren't read by cFixLifecycle; cast through unknown for the spec.
} as unknown as AppLocale['coreFilenames'];

const files = new Map<string, string>([
    [CHARACTERS_FILE, CHARACTERS_KB],
    [FACTIONS_FILE, FACTIONS_KB],
]);

function run(partial: Partial<SaveManifest>) {
    const manifest: SaveManifest = { ...partial };
    return cFixLifecycle(manifest, files, coreFilenames);
}

describe('cFixLifecycle', () => {
    it('passes empty manifest through unchanged', () => {
        const result = run({});
        expect(result.fixes).toEqual([]);
    });

    describe('delete reconciliation', () => {
        it('drops delete for entity not in KB', () => {
            const result = run({
                charactersToDelete: [{ sectionPath: '# 核心人物 > ## 不存在', reason: '...' }],
            });
            expect(result.manifest.charactersToDelete).toEqual([]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-missing-delete' });
        });

        it('keeps delete for entity in KB', () => {
            const del = { sectionPath: '# 核心人物 > ## 李四', reason: 'died' };
            const result = run({ charactersToDelete: [del] });
            expect(result.manifest.charactersToDelete).toEqual([del]);
            expect(result.fixes).toEqual([]);
        });

        it('accepts bare ## L2 sectionPath (model variant without breadcrumb)', () => {
            const result = run({
                charactersToDelete: [{ sectionPath: '## 李四', reason: '...' }],
            });
            expect(result.manifest.charactersToDelete).toHaveLength(1);
        });

        it('rewrites sectionPath to canonical when manifest used the bare form against an aliased KB heading', () => {
            // KB has `## 趙六 (Zhao Liu)`; manifest delete carries bare `## 趙六`.
            // C-fix must rewrite the sectionPath to the aliased form so the
            // downstream handler's strict-equality lookup hits — survival
            // alone isn't enough, the path itself has to change.
            const result = run({
                charactersToDelete: [{ sectionPath: '# 已故人物 > ## 趙六', reason: '...' }],
            });
            expect(result.manifest.charactersToDelete).toEqual([
                { sectionPath: '# 已故人物 > ## 趙六 (Zhao Liu)', reason: '...' },
            ]);
            expect(result.fixes.some(f => f.kind === 'canonicalized-op-path')).toBe(true);
        });

        it('rewrites sectionPath to canonical in the reverse direction (over-qualified manifest, bare KB)', () => {
            // KB has bare `## 李四`; manifest delete carries `## 李四 (Li Si)`.
            // Symmetric resolution + rewrite must shorten the path to match KB.
            const result = run({
                charactersToDelete: [{ sectionPath: '# 核心人物 > ## 李四 (Li Si)', reason: '...' }],
            });
            expect(result.manifest.charactersToDelete).toEqual([
                { sectionPath: '# 核心人物 > ## 李四', reason: '...' },
            ]);
            expect(result.fixes.some(f => f.kind === 'canonicalized-op-path')).toBe(true);
        });

        it('does NOT emit a canonicalization fix when path already matches canonical', () => {
            const result = run({
                charactersToDelete: [{ sectionPath: '# 核心人物 > ## 李四', reason: '...' }],
            });
            expect(result.fixes.filter(f => f.kind === 'canonicalized-op-path')).toEqual([]);
        });

        it('dedupes multiple deletes for the same canonical entity (keep last)', () => {
            // Two deletes for the same entity → handler would emit two delete
            // hunks targeting the same KB block; second fails on apply. Kept
            // entry is the LAST one (with its original sectionPath; the
            // rewriter only changes the L2 segment if alias mismatch).
            const result = run({
                charactersToDelete: [
                    { sectionPath: '# 核心人物 > ## 李四', reason: 'first' },
                    { sectionPath: '## 李四', reason: 'second' },
                ],
            });
            expect(result.manifest.charactersToDelete).toEqual([
                { sectionPath: '## 李四', reason: 'second' },
            ]);
            expect(result.fixes.some(f => f.kind === 'dropped-stale-dup-delete')).toBe(true);
        });

        it('drops delete with malformed sectionPath', () => {
            const result = run({
                charactersToDelete: [{ sectionPath: 'no atx marker here', reason: '...' }],
            });
            expect(result.manifest.charactersToDelete).toEqual([]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-malformed-delete-path' });
        });
    });

    describe('move reconciliation', () => {
        it('drops move when fromSection unresolved', () => {
            const result = run({
                charactersToMove: [{
                    fromSectionPath: '# 核心人物 > ## 不存在',
                    toGroup: '已故人物',
                    reason: '...',
                }],
            });
            expect(result.manifest.charactersToMove).toEqual([]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-missing-move' });
        });

        it('short-circuits move when same entity is being deleted', () => {
            const result = run({
                charactersToDelete: [{ sectionPath: '# 核心人物 > ## 李四', reason: '...' }],
                charactersToMove: [{
                    fromSectionPath: '# 核心人物 > ## 李四',
                    toGroup: '已故人物',
                    reason: '...',
                }],
            });
            expect(result.manifest.charactersToMove).toEqual([]);
            expect(result.fixes.some(f => f.kind === 'shortcircuit-move-by-delete')).toBe(true);
        });

        it('dedupes multiple moves of the same canonical entity (keep last toGroup)', () => {
            // Two moves for the same entity to different toGroups would
            // delete the source block once (second delete fails) BUT each
            // append still fires — entity ends up in BOTH target groups.
            // Last-wins dedup keeps only the latest intent.
            const result = run({
                charactersToMove: [
                    { fromSectionPath: '# 核心人物 > ## 李四', toGroup: '已故人物', reason: 'died' },
                    { fromSectionPath: '# 核心人物 > ## 李四', toGroup: '失蹤人物', reason: 'oops, just missing' },
                ],
            });
            expect(result.manifest.charactersToMove).toEqual([
                { fromSectionPath: '# 核心人物 > ## 李四', toGroup: '失蹤人物', reason: 'oops, just missing' },
            ]);
            expect(result.fixes.some(f => f.kind === 'dropped-stale-dup-move')).toBe(true);
        });

        it('short-circuits move under alias mismatch (bare delete path, aliased move path)', () => {
            // Mirror of the update regression: delete uses bare name, move
            // uses aliased KB form. Both must resolve to the same canonical
            // heading for the short-circuit to fire.
            const result = run({
                charactersToDelete: [{ sectionPath: '# 已故人物 > ## 趙六', reason: '...' }],
                charactersToMove: [{
                    fromSectionPath: '# 已故人物 > ## 趙六 (Zhao Liu)',
                    toGroup: '雜項',
                    reason: '...',
                }],
            });
            expect(result.manifest.charactersToMove).toEqual([]);
            expect(result.fixes.some(f => f.kind === 'shortcircuit-move-by-delete')).toBe(true);
        });
    });

    describe('update reconciliation', () => {
        it('drops update entry for entity not in KB (name typo)', () => {
            const result = run({
                charactersToUpdate: [{
                    name: '李肆',
                    updates: [{ sectionPath: '# 核心人物 > ## 李肆', replacement: '...' }],
                }],
            });
            expect(result.manifest.charactersToUpdate).toEqual([]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-update-name-typo' });
        });

        it('short-circuits update when same entity is being deleted', () => {
            const result = run({
                charactersToDelete: [{ sectionPath: '# 核心人物 > ## 李四', reason: '...' }],
                charactersToUpdate: [{
                    name: '李四',
                    updates: [{ sectionPath: '# 核心人物 > ## 李四', replacement: '...' }],
                }],
            });
            expect(result.manifest.charactersToUpdate).toEqual([]);
            expect(result.fixes.some(f => f.kind === 'shortcircuit-update-by-delete')).toBe(true);
        });

        it('short-circuits update when same entity is being moved', () => {
            // Same shape as delete-vs-update: move's strict-lookup target on
            // the L2 heading and update's replace target on the same heading
            // both anchor to the same KB block; second hunk would fail on
            // apply, losing the update.
            const result = run({
                charactersToMove: [{
                    fromSectionPath: '# 核心人物 > ## 李四',
                    toGroup: '已故人物',
                    reason: '...',
                }],
                charactersToUpdate: [{
                    name: '李四',
                    updates: [{ sectionPath: '# 核心人物 > ## 李四', replacement: '...' }],
                }],
            });
            expect(result.manifest.charactersToUpdate).toEqual([]);
            expect(result.fixes.some(f => f.kind === 'shortcircuit-update-by-move')).toBe(true);
        });

        it('short-circuits update under alias mismatch (aliased KB heading, bare name on update side)', () => {
            // Regression: delete's sectionPath carries the aliased KB form,
            // update's `name` carries the bare form. A naive Set.has() on
            // the raw strings misses the short-circuit, letting the update
            // try to patch a soon-to-be-deleted entity.
            const result = run({
                charactersToDelete: [{ sectionPath: '# 已故人物 > ## 趙六 (Zhao Liu)', reason: '...' }],
                charactersToUpdate: [{
                    name: '趙六',
                    updates: [{ sectionPath: '# 已故人物 > ## 趙六', replacement: '...' }],
                }],
            });
            expect(result.manifest.charactersToUpdate).toEqual([]);
            expect(result.fixes.some(f => f.kind === 'shortcircuit-update-by-delete')).toBe(true);
        });

        it('drops SectionUpdate whose sectionPath is out of scope', () => {
            const result = run({
                charactersToUpdate: [{
                    name: '李四',
                    updates: [
                        { sectionPath: '# 核心人物 > ## 李四', target: 'a', replacement: 'b' },
                        { sectionPath: '# 核心人物 > ## 王五', replacement: 'wrong entity' },
                    ],
                }],
            });
            expect(result.manifest.charactersToUpdate).toEqual([{
                name: '李四',
                updates: [{ sectionPath: '# 核心人物 > ## 李四', target: 'a', replacement: 'b' }],
            }]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-section-out-of-scope' });
        });

        it('drops the whole EntityUpdate when every SectionUpdate is out of scope', () => {
            const result = run({
                charactersToUpdate: [{
                    name: '李四',
                    updates: [
                        { sectionPath: '# 核心人物 > ## 王五', replacement: 'wrong' },
                    ],
                }],
            });
            expect(result.manifest.charactersToUpdate).toEqual([]);
        });

        it('passes through bare EntityUpdate (sub-agent slot, no `updates`)', () => {
            const result = run({
                charactersToUpdate: [{ name: '李四', reasonHint: 'after war' }],
            });
            expect(result.manifest.charactersToUpdate).toEqual([
                { name: '李四', reasonHint: 'after war' },
            ]);
        });

        it('canonicalizes EntityUpdate.name and each updates[].sectionPath under aliasing', () => {
            // Manifest emits bare `李四`; KB has bare `## 李四` too — no rewrite.
            // But for `趙六` (KB has aliased `趙六 (Zhao Liu)`), bare manifest
            // input gets rewritten in both .name and nested sectionPath.
            const result = run({
                charactersToUpdate: [{
                    name: '趙六',
                    updates: [
                        { sectionPath: '# 已故人物 > ## 趙六', target: 'a', replacement: 'b' },
                        { sectionPath: '# 已故人物 > ## 趙六 > ### 心態', replacement: '\n- 平靜' },
                    ],
                }],
            });
            expect(result.manifest.charactersToUpdate).toEqual([{
                name: '趙六 (Zhao Liu)',
                updates: [
                    { sectionPath: '# 已故人物 > ## 趙六 (Zhao Liu)', target: 'a', replacement: 'b' },
                    { sectionPath: '# 已故人物 > ## 趙六 (Zhao Liu) > ### 心態', replacement: '\n- 平靜' },
                ],
            }]);
            expect(result.fixes.some(f => f.kind === 'canonicalized-update-name')).toBe(true);
        });

        it('accepts L3+ deeper sectionPath under entity', () => {
            const result = run({
                charactersToUpdate: [{
                    name: '李四',
                    updates: [
                        { sectionPath: '# 核心人物 > ## 李四 > ### 心態', replacement: 'x' },
                    ],
                }],
            });
            expect(result.manifest.charactersToUpdate).toEqual([{
                name: '李四',
                updates: [{ sectionPath: '# 核心人物 > ## 李四 > ### 心態', replacement: 'x' }],
            }]);
        });
    });

    describe('merge duplicate update entries (same canonical name)', () => {
        it('concatenates .updates from two entries with the same canonical name', () => {
            // Regression: previously two EntityUpdate entries for the same
            // entity both survived, and overlapping sectionPaths would emit
            // two replace hunks anchored to the same KB block — second hunk
            // fails on apply, losing the update.
            const result = run({
                charactersToUpdate: [
                    {
                        name: '李四',
                        updates: [
                            { sectionPath: '# 核心人物 > ## 李四 > ### 心態', replacement: 'A' },
                        ],
                    },
                    {
                        name: '李四',
                        updates: [
                            { sectionPath: '# 核心人物 > ## 李四 > ### 背景', replacement: 'B' },
                        ],
                    },
                ],
            });
            expect(result.manifest.charactersToUpdate).toEqual([
                {
                    name: '李四',
                    updates: [
                        { sectionPath: '# 核心人物 > ## 李四 > ### 心態', replacement: 'A' },
                        { sectionPath: '# 核心人物 > ## 李四 > ### 背景', replacement: 'B' },
                    ],
                },
            ]);
            expect(result.fixes.some(f => f.kind === 'merged-duplicate-update-entry')).toBe(true);
        });

        it('merges alias-different names that resolve to the same canonical', () => {
            // KB has `## 趙六 (Zhao Liu)`. The LLM emits two entries naming the
            // same entity via prefix-alias ("趙六"). Both should canonicalize
            // to "趙六 (Zhao Liu)" and merge into one. Use sectionPaths that
            // also use the prefix-alias so the in-scope check passes.
            const result = run({
                charactersToUpdate: [
                    {
                        name: '趙六',
                        updates: [
                            { sectionPath: '# 已故人物 > ## 趙六 > ### 心態', replacement: 'A' },
                        ],
                    },
                    {
                        name: '趙六',
                        updates: [
                            { sectionPath: '# 已故人物 > ## 趙六 > ### 背景', replacement: 'B' },
                        ],
                    },
                ],
            });
            expect(result.manifest.charactersToUpdate).toHaveLength(1);
            expect(result.manifest.charactersToUpdate?.[0].name).toBe('趙六 (Zhao Liu)');
            expect(result.manifest.charactersToUpdate?.[0].updates).toHaveLength(2);
            expect(result.fixes.some(f => f.kind === 'merged-duplicate-update-entry')).toBe(true);
        });

        it('does NOT merge different canonical names', () => {
            const result = run({
                charactersToUpdate: [
                    {
                        name: '李四',
                        updates: [{ sectionPath: '# 核心人物 > ## 李四 > ### 心態', replacement: 'A' }],
                    },
                    {
                        name: '王五',
                        updates: [{ sectionPath: '# 核心人物 > ## 王五 > ### 心態', replacement: 'B' }],
                    },
                ],
            });
            expect(result.manifest.charactersToUpdate).toHaveLength(2);
            expect(result.fixes.some(f => f.kind === 'merged-duplicate-update-entry')).toBe(false);
        });
    });

    describe('factions parallel', () => {
        it('drops faction delete not in KB', () => {
            const result = run({
                factionsToDelete: [{ sectionPath: '# 主要勢力 > ## 不存在', reason: '...' }],
            });
            expect(result.manifest.factionsToDelete).toEqual([]);
            expect(result.fixes[0]).toMatchObject({ kind: 'dropped-missing-delete' });
            expect(result.fixes[0].reason).toContain('factionsToDelete');
        });

        it('keeps faction delete present in KB', () => {
            const del = { sectionPath: '# 主要勢力 > ## 天劍門', reason: '...' };
            const result = run({ factionsToDelete: [del] });
            expect(result.manifest.factionsToDelete).toEqual([del]);
        });
    });
});
