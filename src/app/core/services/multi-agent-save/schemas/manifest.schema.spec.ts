import { describe, expect, it } from 'vitest';
import { SAVE_MANIFEST_SCHEMA, validateManifest } from './manifest.schema';

describe('SAVE_MANIFEST_SCHEMA shape', () => {
    it('declares no required fields at the top level (allows truncation salvage)', () => {
        const schema = SAVE_MANIFEST_SCHEMA as { required?: string[] };
        expect(schema.required).toBeUndefined();
    });

    it('lists every optional manifest field as an array of objects', () => {
        const schema = SAVE_MANIFEST_SCHEMA as { properties: Record<string, { type: string }> };
        const arrayFields = [
            'inventoryDeltas', 'assetsDeltas', 'plansDeltas',
            'techEquipmentUpdates', 'magicSkillsUpdates', 'worldFeaturesUpdates',
            'charactersToCreate', 'factionsToCreate',
            'charactersToDelete', 'factionsToDelete',
            'charactersToMove', 'factionsToMove',
            'charactersToUpdate', 'factionsToUpdate',
        ];
        for (const f of arrayFields) {
            expect(schema.properties[f], `${f} missing`).toBeDefined();
            expect(schema.properties[f].type, `${f} wrong type`).toBe('array');
        }
    });
});

describe('validateManifest', () => {
    const minimalAudit = { processedLogIds: [], skippedLogIds: [] };

    it('accepts the empty-but-audit-only manifest', () => {
        const r = validateManifest({ completenessAudit: minimalAudit });
        expect(r.ok).toBe(true);
    });

    it('accepts manifests missing completenessAudit (truncation salvage)', () => {
        // The schema is loose on completenessAudit because a max_tokens
        // truncation often drops the tail — better to apply partial section
        // deltas than reject the whole save. Orchestrator still warns via
        // finishReason in that case.
        expect(validateManifest({}).ok).toBe(true);
    });

    it('rejects when value is not an object', () => {
        expect(validateManifest(null).ok).toBe(false);
        expect(validateManifest([]).ok).toBe(false);
        expect(validateManifest('foo').ok).toBe(false);
    });

    it('rejects when skippedLogIds entries lack logId/reason', () => {
        const r = validateManifest({
            completenessAudit: { processedLogIds: [], skippedLogIds: [{ logId: 'x' }] },
        });
        expect(r.ok).toBe(false);
    });

    it('accepts inventoryDeltas with valid op + item', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            inventoryDeltas: [
                { op: 'add', item: '長劍', details: '一柄精鋼長劍' },
                { op: 'remove', item: '舊木劍' },
                { op: 'update', item: '長劍', details: '刃口出現缺口' },
            ],
        });
        expect(r.ok).toBe(true);
    });

    it('rejects inventoryDeltas with unknown op', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            inventoryDeltas: [{ op: 'replace', item: 'x' }],
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/inventoryDeltas\[0\]\.op/);
    });

    it('rejects inventoryDeltas with non-string item', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            inventoryDeltas: [{ op: 'add', item: 42 }],
        });
        expect(r.ok).toBe(false);
    });

    it('accepts character/faction create with full draftedFields', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            charactersToCreate: [{
                name: '張三',
                group: '次要人物',
                draftedFields: { 身分: '商人', 基本設定: '...' },
            }],
        });
        expect(r.ok).toBe(true);
    });

    it('rejects character create with non-string draftedFields value', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            charactersToCreate: [{ name: 'x', group: 'y', draftedFields: { f: 1 } }],
        });
        expect(r.ok).toBe(false);
    });

    it('rejects move missing toGroup', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            charactersToMove: [{ fromSectionPath: '# 核心人物 > ## x', reason: 'died' }],
        });
        expect(r.ok).toBe(false);
    });

    it('rejects delete missing sectionPath', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            charactersToDelete: [{ reason: 'died' }],
        });
        expect(r.ok).toBe(false);
    });

    it('rejects move missing fromSectionPath', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            charactersToMove: [{ toGroup: '已故人物', reason: 'died' }],
        });
        expect(r.ok).toBe(false);
    });

    it('accepts charactersToUpdate with 1-call updates payload', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            charactersToUpdate: [{
                name: '李四',
                updates: [
                    { sectionPath: '# 核心人物 > ## 李四', target: '舊狀態', replacement: '新狀態' },
                    { sectionPath: '# 核心人物 > ## 李四', replacement: '\n- 新增筆記' },
                ],
            }],
        });
        expect(r.ok).toBe(true);
    });

    it('rejects charactersToUpdate.updates with malformed entry', () => {
        const r = validateManifest({
            completenessAudit: minimalAudit,
            charactersToUpdate: [{
                name: '李四',
                updates: [{ sectionPath: '# X > ## Y' }],  // missing `replacement`
            }],
        });
        expect(r.ok).toBe(false);
    });

    it('accepts a fully-populated manifest', () => {
        const r = validateManifest({
            storyOutlineBlock: '## Act.1 ...',
            inventoryDeltas: [{ op: 'add', item: 'x', details: 'y' }],
            assetsDeltas: [],
            plansDeltas: [{ op: 'add', title: 'p', body: 'b' }],
            techEquipmentUpdates: [{ sectionPath: '# X > ## Y', target: 'old', replacement: 'new' }],
            magicSkillsUpdates: [],
            worldFeaturesUpdates: [],
            charactersToCreate: [],
            factionsToCreate: [],
            charactersToDelete: [{ sectionPath: '# 核心人物 > ## 王五', reason: 'died' }],
            factionsToDelete: [],
            charactersToMove: [{ fromSectionPath: '# 核心人物 > ## 李四', toGroup: '已故人物', reason: 'died' }],
            factionsToMove: [],
            charactersToUpdate: [{
                name: '李四',
                updates: [{ sectionPath: '# 核心人物 > ## 李四', target: 'old', replacement: 'new' }],
            }],
            factionsToUpdate: [{ name: '某派', reasonHint: 'after war' }],
            completenessAudit: { processedLogIds: ['a'], skippedLogIds: [{ logId: 'b', reason: 'irrelevant' }] },
        });
        expect(r.ok).toBe(true);
    });
});
