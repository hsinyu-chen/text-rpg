import { describe, expect, it } from 'vitest';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type { SaveManifest } from '../multi-agent-save.types';
import { cFixRunner } from './c-fix-runner';

const INVENTORY_FILE = '5.主角的物品.md';
const ASSETS_FILE = '4.主角的資產.md';
const PLANS_FILE = '8.計畫.md';
const CHARACTERS_FILE = '3.人物狀態.md';
const FACTIONS_FILE = '6.勢力與世界.md';

const coreFilenames = {
    INVENTORY: INVENTORY_FILE,
    ASSETS: ASSETS_FILE,
    PLANS: PLANS_FILE,
    CHARACTER_STATUS: CHARACTERS_FILE,
    WORLD_FACTIONS: FACTIONS_FILE,
    // Other fields aren't read; cast through unknown for the spec.
} as unknown as AppLocale['coreFilenames'];

const CHARACTERS_KB = [
    '# 核心人物',
    '',
    '## 李四',
    '- 身分: 劍士',
].join('\n');

const PLANS_KB = [
    '## 「奪回神兵」計畫',
    '',
    '- **發起者**: 李四',
].join('\n');

const INVENTORY_KB = '- 玄鐵令 — 信物';

function run(manifest: SaveManifest, files?: Map<string, string>) {
    const kbFiles = files ?? new Map<string, string>([
        [CHARACTERS_FILE, CHARACTERS_KB],
        [FACTIONS_FILE, ''],
        [PLANS_FILE, PLANS_KB],
        [INVENTORY_FILE, INVENTORY_KB],
        [ASSETS_FILE, ''],
    ]);
    return cFixRunner({ manifest, kbFiles, coreFilenames });
}

describe('cFixRunner', () => {
    it('passes empty manifest through with no fixes', () => {
        const result = run({});
        expect(result.fixes).toEqual([]);
    });

    it('composes fixes across multiple domains in a single pass', () => {
        // One issue per module — verify each surfaces in the combined fixes
        // and the manifest comes back with all corrections applied.
        const result = run({
            inventoryDeltas: [
                // dup add → pass 1 converts add → update (玄鐵令 in KB).
                { op: 'add', item: '玄鐵令', details: '新描述' },
            ],
            plansDeltas: [
                // missing-remove → dropped.
                { op: 'remove', title: '不存在的計畫' },
            ],
            techEquipmentUpdates: [
                // dup append → merged into one.
                { sectionPath: '## 玄鐵令', replacement: '\n- A' },
                { sectionPath: '## 玄鐵令', replacement: '\n- B' },
            ],
            charactersToDelete: [
                // missing entity → dropped.
                { sectionPath: '# 核心人物 > ## 不存在', reason: '...' },
            ],
        });

        const kinds = result.fixes.map(f => f.kind);
        expect(kinds).toContain('add-merged-to-update');
        expect(kinds).toContain('dropped-missing-remove');
        expect(kinds).toContain('merged-dup-appends');
        expect(kinds).toContain('dropped-missing-delete');

        expect(result.manifest.inventoryDeltas).toEqual([
            { op: 'update', item: '玄鐵令', details: '新描述' },
        ]);
        expect(result.manifest.plansDeltas).toEqual([]);
        expect(result.manifest.techEquipmentUpdates).toEqual([
            { sectionPath: '## 玄鐵令', replacement: '\n- A\n- B' },
        ]);
        expect(result.manifest.charactersToDelete).toEqual([]);
    });

    it('lifecycle short-circuits update for entity being deleted', () => {
        // Delete wins; the update entry is dropped before its SectionUpdates
        // are deduped.
        const result = run({
            charactersToDelete: [
                { sectionPath: '# 核心人物 > ## 李四', reason: 'died' },
            ],
            charactersToUpdate: [
                {
                    name: '李四',
                    updates: [
                        { sectionPath: '# 核心人物 > ## 李四', replacement: 'a' },
                        { sectionPath: '# 核心人物 > ## 李四', replacement: 'b' },
                    ],
                },
            ],
        });
        expect(result.manifest.charactersToUpdate).toEqual([]);
        expect(result.fixes.some(f => f.kind === 'shortcircuit-update-by-delete')).toBe(true);
        // The two appends were never deduped because the whole entry was
        // dropped first — verify NO merged-dup-appends fix for this entity.
        expect(result.fixes.some(f =>
            f.kind === 'merged-dup-appends' && f.reason.includes('李四')
        )).toBe(false);
    });

    it('runs section dedupe INSIDE surviving EntityUpdate.updates', () => {
        // Update for an entity that exists, with dup appends — runner should
        // pass through lifecycle (no short-circuit) then dedupe in pass 5.
        const result = run({
            charactersToUpdate: [
                {
                    name: '李四',
                    updates: [
                        { sectionPath: '# 核心人物 > ## 李四', replacement: '\n- A' },
                        { sectionPath: '# 核心人物 > ## 李四', replacement: '\n- B' },
                    ],
                },
            ],
        });
        expect(result.manifest.charactersToUpdate).toEqual([
            {
                name: '李四',
                updates: [
                    { sectionPath: '# 核心人物 > ## 李四', replacement: '\n- A\n- B' },
                ],
            },
        ]);
        expect(result.fixes.some(f =>
            f.kind === 'merged-dup-appends' && f.reason.includes('李四')
        )).toBe(true);
    });

    it('is re-entrant — running on the fixed manifest yields zero new fixes', () => {
        // Sub-3 will invoke the runner twice (after main LLM, after A agents);
        // verify the second pass on already-clean output is a no-op.
        const first = run({
            inventoryDeltas: [
                { op: 'add', item: '玄鐵令', details: '描述' },
                { op: 'add', item: '玄鐵令', details: '描述2' },
            ],
        });
        expect(first.fixes.length).toBeGreaterThan(0);

        const second = cFixRunner({
            manifest: first.manifest,
            kbFiles: new Map([
                [INVENTORY_FILE, INVENTORY_KB],
                [ASSETS_FILE, ''],
                [PLANS_FILE, ''],
                [CHARACTERS_FILE, ''],
                [FACTIONS_FILE, ''],
            ]),
            coreFilenames,
        });
        expect(second.fixes).toEqual([]);
        expect(second.manifest.inventoryDeltas).toEqual(first.manifest.inventoryDeltas);
    });

    it('handles missing KB files gracefully (empty string fallback)', () => {
        // Some books may not have plans / assets KB files. Runner should
        // treat absent file as empty content, not crash.
        const result = run(
            {
                plansDeltas: [{ op: 'remove', title: '任何' }],
            },
            new Map([
                [INVENTORY_FILE, ''],
                [ASSETS_FILE, ''],
                [CHARACTERS_FILE, ''],
                [FACTIONS_FILE, ''],
                // PLANS_FILE intentionally absent
            ]),
        );
        expect(result.manifest.plansDeltas).toEqual([]);
        expect(result.fixes.some(f => f.kind === 'dropped-missing-remove')).toBe(true);
    });
});
