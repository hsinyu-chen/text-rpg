import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SubToolDispatcherService } from './sub-tool-dispatcher.service';
import { SaveProgressTracker } from './progress/save-progress-tracker.service';
import type { SaveManifest } from './multi-agent-save.types';
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

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const dispatcher = TestBed.inject(SubToolDispatcherService);
    const tracker = TestBed.inject(SaveProgressTracker);
    tracker.reset();
    return { dispatcher, tracker };
}

describe('SubToolDispatcherService', () => {
    let svc: ReturnType<typeof setup>;

    beforeEach(() => {
        svc = setup();
    });

    it('emits empty_section skip for every mechanical tool when manifest is empty', () => {
        const result = svc.dispatcher.dispatch({
            manifest: emptyManifest,
            coreFilenames: files(),
            kbSectionHeadings: HEADINGS,
            kbFiles: new Map(),
        });
        expect(result.xml).toBe('');
        const entries = svc.tracker.entries();
        expect(entries.every(e => e.state === 'skipped' && e.statusReason === 'empty_section')).toBe(true);
        // 13 mechanical tools in MECHANICAL_TOOL_NAMES — every one gets one entry.
        expect(entries).toHaveLength(13);
    });

    it('dispatches inventoryDeltas through the wired handler', () => {
        const manifest: SaveManifest = {
            ...emptyManifest,
            inventoryDeltas: [{ op: 'add', item: '長劍', details: '精鋼鍛造' }],
        };
        const result = svc.dispatcher.dispatch({
            manifest,
            coreFilenames: files(),
            kbSectionHeadings: HEADINGS,
            kbFiles: new Map([['9.物品欄.md', '']]),
        });
        expect(result.xml).toContain('<save file="9.物品欄.md"');
        expect(result.xml).toContain('長劍');

        const invEntry = svc.tracker.entries().find(e => e.toolName === 'inventoryDeltas');
        expect(invEntry?.state).toBe('done');
        expect(invEntry?.output).toContain('長劍');
    });

    it('routes assetsDeltas + charactersToCreate through their now-wired handlers', () => {
        // A2 wired every mechanical tool. The previous "not_yet_implemented"
        // skip on assets / character-create has been replaced with real XML
        // output via the dispatch path.
        const manifest: SaveManifest = {
            ...emptyManifest,
            assetsDeltas: [{ op: 'add', item: '金幣 100' }],
            charactersToCreate: [{ name: 'X', group: 'Y', draftedFields: { 身分: 'Z' } }],
        };
        const result = svc.dispatcher.dispatch({
            manifest,
            coreFilenames: files(),
            kbSectionHeadings: HEADINGS,
            kbFiles: new Map(),
        });
        expect(result.xml).toContain('<save file="4.資產.md"');
        expect(result.xml).toContain('金幣 100');
        expect(result.xml).toContain('<save file="3.人物狀態.md"');
        expect(result.xml).toContain('## X');

        const entries = svc.tracker.entries();
        expect(entries.find(e => e.toolName === 'assetsDeltas')?.state).toBe('done');
        expect(entries.find(e => e.toolName === 'charactersToCreate')?.state).toBe('done');
        // No mechanical tool should be reported as not_yet_implemented any more.
        const notImpl = entries.filter(e =>
            e.state === 'skipped' &&
            e.statusReason === 'not_yet_implemented' &&
            e.toolName !== 'charactersToUpdate' &&
            e.toolName !== 'factionsToUpdate',
        );
        expect(notImpl).toHaveLength(0);
    });

    it('records sub-agent (no-updates) entity entries as not_yet_implemented', () => {
        const manifest: SaveManifest = {
            ...emptyManifest,
            charactersToUpdate: [{ name: '李四', reasonHint: 'after war' }],
        };
        svc.dispatcher.dispatch({
            manifest,
            coreFilenames: files(),
            kbSectionHeadings: HEADINGS,
            kbFiles: new Map(),
        });
        const llmEntry = svc.tracker.entries().find(e => e.toolName === 'charactersToUpdate');
        expect(llmEntry?.state).toBe('skipped');
        expect(llmEntry?.statusReason).toBe('not_yet_implemented');
    });

    it('dispatches 1-call mode entity updates through applyEntityPatches', () => {
        const manifest: SaveManifest = {
            ...emptyManifest,
            charactersToUpdate: [{
                name: '李四',
                updates: [
                    { sectionPath: '# 核心人物 > ## 李四', replacement: '\n- 新增筆記' },
                ],
            }],
        };
        const result = svc.dispatcher.dispatch({
            manifest,
            coreFilenames: files(),
            kbSectionHeadings: HEADINGS,
            kbFiles: new Map([['3.人物狀態.md', '']]),
        });
        expect(result.xml).toContain('<save file="3.人物狀態.md"');
        expect(result.xml).toContain('context="# 核心人物 > ## 李四"');
        expect(result.xml).toContain('新增筆記');
        const entry = svc.tracker.entries().find(e => e.toolName === 'charactersToUpdate');
        expect(entry?.state).toBe('done');
    });

    it('emits BOTH a done entry (mechanical part) and a not_yet_implemented entry (sub-agent part) when the manifest mixes the two', () => {
        const manifest: SaveManifest = {
            ...emptyManifest,
            charactersToUpdate: [
                {
                    name: '李四',
                    updates: [{ sectionPath: '# 核心人物 > ## 李四', replacement: '\n- x' }],
                },
                { name: '王五', reasonHint: 'sub-agent later' },
            ],
        };
        svc.dispatcher.dispatch({
            manifest,
            coreFilenames: files(),
            kbSectionHeadings: HEADINGS,
            kbFiles: new Map([['3.人物狀態.md', '']]),
        });
        const entries = svc.tracker.entries().filter(e => e.toolName === 'charactersToUpdate');
        expect(entries).toHaveLength(2);
        expect(entries.some(e => e.state === 'done')).toBe(true);
        expect(entries.some(e => e.state === 'skipped' && e.statusReason === 'not_yet_implemented')).toBe(true);
    });

    it('does NOT emit an entity-update entry when the section is empty', () => {
        svc.dispatcher.dispatch({
            manifest: emptyManifest,
            coreFilenames: files(),
            kbSectionHeadings: HEADINGS,
            kbFiles: new Map(),
        });
        const llmEntries = svc.tracker.entries()
            .filter(e => e.toolName === 'charactersToUpdate' || e.toolName === 'factionsToUpdate');
        expect(llmEntries).toHaveLength(0);
    });

    it('produces empty_section skip when the handler returns "" (all ops dropped)', () => {
        // The inventory handler drops remove ops whose target line is not in
        // the file. With an empty file, this manifest yields zero ops.
        const manifest: SaveManifest = {
            ...emptyManifest,
            inventoryDeltas: [{ op: 'remove', item: '不存在的物品' }],
        };
        svc.dispatcher.dispatch({
            manifest,
            coreFilenames: files(),
            kbSectionHeadings: HEADINGS,
            kbFiles: new Map([['9.物品欄.md', '']]),
        });
        const entry = svc.tracker.entries().find(e => e.toolName === 'inventoryDeltas');
        expect(entry?.state).toBe('skipped');
        expect(entry?.statusReason).toBe('empty_section');
    });
});
