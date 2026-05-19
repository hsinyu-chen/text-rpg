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

describe('targetFileFor', () => {
    it('maps inventoryDeltas to INVENTORY', () => {
        expect(targetFileFor('inventoryDeltas', files())).toBe('9.物品欄.md');
    });

    it('returns null for tools Phase 1 has not wired', () => {
        expect(targetFileFor('assetsDeltas', files())).toBeNull();
        expect(targetFileFor('plansDeltas', files())).toBeNull();
        expect(targetFileFor('charactersToCreate', files())).toBeNull();
        expect(targetFileFor('worldFeaturesUpdates', files())).toBeNull();
    });
});

describe('MECHANICAL_HANDLERS registry', () => {
    it('exposes a wired inventoryDeltas handler', () => {
        expect(MECHANICAL_HANDLERS.inventoryDeltas).toBeDefined();
    });

    it('inventoryDeltas handler returns the empty string for an empty manifest section', () => {
        const h = MECHANICAL_HANDLERS.inventoryDeltas!;
        const xml = h(emptyManifest, { targetFile: '9.物品欄.md', fileContent: '' });
        expect(xml).toBe('');
    });

    it('inventoryDeltas handler emits XML for non-empty deltas', () => {
        const h = MECHANICAL_HANDLERS.inventoryDeltas!;
        const xml = h({
            ...emptyManifest,
            inventoryDeltas: [{ op: 'add', item: '長劍' }],
        }, { targetFile: '9.物品欄.md', fileContent: '' });
        expect(xml).toContain('<save file="9.物品欄.md"');
        expect(xml).toContain('長劍');
    });

    it('Phase 1 unwired tools are intentionally absent from the registry (not stubbed)', () => {
        // The dispatcher distinguishes "wired but empty" from "not implemented"
        // by registry membership — preserve that contract here.
        expect(MECHANICAL_HANDLERS.assetsDeltas).toBeUndefined();
        expect(MECHANICAL_HANDLERS.charactersToCreate).toBeUndefined();
        expect(MECHANICAL_HANDLERS.worldFeaturesUpdates).toBeUndefined();
    });
});
