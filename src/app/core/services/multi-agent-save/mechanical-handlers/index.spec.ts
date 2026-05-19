import { describe, expect, it } from 'vitest';
import { MECHANICAL_HANDLERS, targetFileFor } from './index';
import type { SaveManifest } from '../multi-agent-save.types';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';

function files(): AppLocale['coreFilenames'] {
    return {
        BASIC_SETTINGS: '1.基礎設定.md',
        STORY_OUTLINE: '2.劇情綱要.md',
        CHARACTER_STATUS: '3.人物狀態.md',
        ASSETS: '4.資產.md',
        TECH_EQUIPMENT: '5.科技裝備.md',
        WORLD_FACTIONS: '6.勢力與世界.md',
        MAGIC: '7.魔法與技能.md',
        PLANS: '8.計畫.md',
        INVENTORY: '9.物品欄.md',
    };
}

const emptyManifest: SaveManifest = {
    completenessAudit: { processedLogIds: [], skippedLogIds: [] },
};

const HEADINGS = { STORY_OUTLINE_CHRONICLE: '劇情綱要' };
const ctxFor = (file: string, fileContent = '') => ({ targetFile: file, fileContent, kbSectionHeadings: HEADINGS });

describe('targetFileFor', () => {
    it('maps every mechanical tool to the right locale file', () => {
        // A2 wires every mechanical tool; only LLM sub-tools
        // (charactersToUpdate / factionsToUpdate) live outside this map.
        const f = files();
        expect(targetFileFor('inventoryDeltas', f)).toBe(f.INVENTORY);
        expect(targetFileFor('assetsDeltas', f)).toBe(f.ASSETS);
        expect(targetFileFor('plansDeltas', f)).toBe(f.PLANS);
        expect(targetFileFor('storyOutlineBlock', f)).toBe(f.STORY_OUTLINE);
        expect(targetFileFor('techEquipmentUpdates', f)).toBe(f.TECH_EQUIPMENT);
        expect(targetFileFor('magicSkillsUpdates', f)).toBe(f.MAGIC);
        expect(targetFileFor('worldFeaturesUpdates', f)).toBe(f.WORLD_FACTIONS);
        expect(targetFileFor('charactersToCreate', f)).toBe(f.CHARACTER_STATUS);
        expect(targetFileFor('charactersToDelete', f)).toBe(f.CHARACTER_STATUS);
        expect(targetFileFor('charactersToMove', f)).toBe(f.CHARACTER_STATUS);
        expect(targetFileFor('factionsToCreate', f)).toBe(f.WORLD_FACTIONS);
        expect(targetFileFor('factionsToDelete', f)).toBe(f.WORLD_FACTIONS);
        expect(targetFileFor('factionsToMove', f)).toBe(f.WORLD_FACTIONS);
    });
});

describe('MECHANICAL_HANDLERS registry', () => {
    it('wires every mechanical tool — A2 closes the Phase 1 mechanical surface', () => {
        // The dispatcher reads "absent from registry" as `not_yet_implemented`.
        // For Phase 1 A2 every mechanical tool must be present; only
        // charactersToUpdate / factionsToUpdate (LLM sub-tools) remain.
        const expected = [
            'inventoryDeltas', 'assetsDeltas', 'plansDeltas', 'storyOutlineBlock',
            'techEquipmentUpdates', 'magicSkillsUpdates', 'worldFeaturesUpdates',
            'charactersToCreate', 'charactersToDelete', 'charactersToMove',
            'factionsToCreate', 'factionsToDelete', 'factionsToMove',
        ] as const;
        for (const tool of expected) {
            expect(MECHANICAL_HANDLERS[tool], `handler for ${tool}`).toBeDefined();
        }
    });

    it('inventoryDeltas handler returns the empty string for an empty manifest section', () => {
        const h = MECHANICAL_HANDLERS.inventoryDeltas!;
        const xml = h(emptyManifest, ctxFor('9.物品欄.md'));
        expect(xml).toBe('');
    });

    it('inventoryDeltas handler emits XML for non-empty deltas', () => {
        const h = MECHANICAL_HANDLERS.inventoryDeltas!;
        const xml = h({
            ...emptyManifest,
            inventoryDeltas: [{ op: 'add', item: '長劍' }],
        }, ctxFor('9.物品欄.md'));
        expect(xml).toContain('<save file="9.物品欄.md"');
        expect(xml).toContain('長劍');
    });

    it('assetsDeltas and inventoryDeltas share the same handler body (same type, same mechanics)', () => {
        // DRY check: the registry routes both to applyInventoryDeltas. A buggy
        // future re-implementation that diverges these will be caught here.
        const inv = MECHANICAL_HANDLERS.inventoryDeltas!;
        const ast = MECHANICAL_HANDLERS.assetsDeltas!;
        const xmlInv = inv({
            ...emptyManifest,
            inventoryDeltas: [{ op: 'add', item: 'X' }],
        }, ctxFor('inv.md'));
        const xmlAst = ast({
            ...emptyManifest,
            assetsDeltas: [{ op: 'add', item: 'X' }],
        }, ctxFor('inv.md'));
        expect(xmlInv).toBe(xmlAst);
    });
});
