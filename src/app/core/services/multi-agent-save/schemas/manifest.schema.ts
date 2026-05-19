import type { Schema } from '@app/core/models/types';
import type { SaveManifest } from '../multi-agent-save.types';

const deltaItem = {
    type: 'object',
    required: ['op', 'item'],
    properties: {
        op: { type: 'string', enum: ['add', 'remove', 'update'] },
        item: { type: 'string', description: 'Item name (original wording)' },
        details: { type: 'string', description: 'New-state description appended after the item name. Strongly encouraged for add/update; omit for remove. May be omitted entirely if the bare item name is the full entry.' },
    },
} as const;

const planItem = {
    type: 'object',
    required: ['op', 'title'],
    properties: {
        op: { type: 'string', enum: ['add', 'remove', 'update'] },
        title: { type: 'string' },
        body: { type: 'string', description: 'Full entry body. Strongly encouraged for add/update; ignored on remove.' },
    },
} as const;

const sectionItem = {
    type: 'object',
    required: ['sectionPath', 'content'],
    properties: {
        sectionPath: { type: 'string', description: "Breadcrumb like '# 已開發武器 > ## 短弓改'" },
        content: { type: 'string' },
    },
} as const;

const characterCreate = {
    type: 'object',
    required: ['name', 'group', 'draftedFields'],
    properties: {
        name: { type: 'string' },
        group: { type: 'string', description: 'L1 group heading text verbatim' },
        draftedFields: {
            type: 'object',
            description: 'Initial entry field map per save-character-status-rules.md',
            additionalProperties: { type: 'string' },
        },
    },
} as const;

const entityDelete = {
    type: 'object',
    required: ['name', 'reason'],
    properties: {
        name: { type: 'string' },
        reason: { type: 'string' },
    },
} as const;

const entityMove = {
    type: 'object',
    required: ['name', 'toGroup', 'reason'],
    properties: {
        name: { type: 'string' },
        toGroup: { type: 'string', description: 'Target L1 group heading' },
        reason: { type: 'string' },
    },
} as const;

const entityUpdate = {
    type: 'object',
    required: ['name'],
    properties: {
        name: { type: 'string' },
        reasonHint: { type: 'string', description: 'Optional motivation hint — trace only' },
    },
} as const;

/**
 * JSON-Schema-subset shape passed to `provider.generateContentStream` as
 * `responseSchema`. Mirrors the {@link SaveManifest} TypeScript interface
 * field-for-field — when the interface changes, this constant must too;
 * `manifest.schema.spec.ts` guards by parsing schema-shaped fixtures and
 * comparing with hand-rolled TS objects.
 *
 * Kept inline (no `$ref` indirection) — providers vary in how they resolve
 * `$ref`, and the manifest is small enough that inlining wins on clarity.
 */
export const SAVE_MANIFEST_SCHEMA: Schema = {
    type: 'object',
    description: 'SaveAgent manifest — top-level routing output. The dispatcher reads each field and fires the matching sub-tool.',
    required: ['completenessAudit'],
    properties: {
        storyOutlineBlock: { type: 'string', description: 'Full story-outline block for this ACT. Empty string = no update.' },
        inventoryDeltas: { type: 'array', items: deltaItem },
        assetsDeltas: { type: 'array', items: deltaItem },
        plansDeltas: { type: 'array', items: planItem },
        techEquipmentUpdates: { type: 'array', items: sectionItem },
        magicSkillsUpdates: { type: 'array', items: sectionItem },
        worldFeaturesUpdates: { type: 'array', items: sectionItem },
        charactersToCreate: { type: 'array', items: characterCreate },
        factionsToCreate: { type: 'array', items: characterCreate },
        charactersToDelete: { type: 'array', items: entityDelete },
        factionsToDelete: { type: 'array', items: entityDelete },
        charactersToMove: { type: 'array', items: entityMove },
        factionsToMove: { type: 'array', items: entityMove },
        charactersToUpdate: { type: 'array', items: entityUpdate },
        factionsToUpdate: { type: 'array', items: entityUpdate },
        completenessAudit: {
            type: 'object',
            required: ['processedLogIds', 'skippedLogIds'],
            properties: {
                processedLogIds: { type: 'array', items: { type: 'string' } },
                skippedLogIds: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['logId', 'reason'],
                        properties: {
                            logId: { type: 'string' },
                            reason: { type: 'string' },
                        },
                    },
                },
            },
        },
    },
};

/**
 * Runtime validation result. Provider structured-output mostly enforces the
 * shape upstream, but local llama.cpp and some cloud providers can return
 * malformed JSON under load — every parsed manifest goes through this.
 */
export type ManifestValidationResult =
    | { ok: true; manifest: SaveManifest }
    | { ok: false; error: string };

/**
 * Validates a parsed JSON value as a `SaveManifest`. Checks structural shape
 * (required fields, enum values, type discriminants) but does NOT enforce
 * cross-field invariants like `completenessAudit.processedLogIds ⊆ actual
 * ACT log ids` — that's audit territory, separate concern.
 */
export function validateManifest(value: unknown): ManifestValidationResult {
    if (!isObject(value)) return { ok: false, error: 'manifest is not an object' };

    const audit = value['completenessAudit'];
    if (!isObject(audit)) return { ok: false, error: 'completenessAudit is missing or not an object' };
    if (!isStringArray(audit['processedLogIds'])) {
        return { ok: false, error: 'completenessAudit.processedLogIds is not a string[]' };
    }
    const skipped = audit['skippedLogIds'];
    if (!Array.isArray(skipped)) {
        return { ok: false, error: 'completenessAudit.skippedLogIds is not an array' };
    }
    for (let i = 0; i < skipped.length; i++) {
        const s = skipped[i];
        if (!isObject(s) || typeof s['logId'] !== 'string' || typeof s['reason'] !== 'string') {
            return { ok: false, error: `completenessAudit.skippedLogIds[${i}] missing logId/reason` };
        }
    }

    for (const key of ['inventoryDeltas', 'assetsDeltas'] as const) {
        const err = validateDeltaArray(value[key], key);
        if (err) return { ok: false, error: err };
    }
    {
        const err = validatePlanArray(value['plansDeltas']);
        if (err) return { ok: false, error: err };
    }
    for (const key of ['techEquipmentUpdates', 'magicSkillsUpdates', 'worldFeaturesUpdates'] as const) {
        const err = validateSectionArray(value[key], key);
        if (err) return { ok: false, error: err };
    }
    for (const key of ['charactersToCreate', 'factionsToCreate'] as const) {
        const err = validateCreateArray(value[key], key);
        if (err) return { ok: false, error: err };
    }
    for (const key of ['charactersToDelete', 'factionsToDelete'] as const) {
        const err = validateDeleteArray(value[key], key);
        if (err) return { ok: false, error: err };
    }
    for (const key of ['charactersToMove', 'factionsToMove'] as const) {
        const err = validateMoveArray(value[key], key);
        if (err) return { ok: false, error: err };
    }
    for (const key of ['charactersToUpdate', 'factionsToUpdate'] as const) {
        const err = validateUpdateArray(value[key], key);
        if (err) return { ok: false, error: err };
    }
    const storyBlock = value['storyOutlineBlock'];
    if (storyBlock !== undefined && typeof storyBlock !== 'string') {
        return { ok: false, error: 'storyOutlineBlock is not a string' };
    }

    return { ok: true, manifest: value as unknown as SaveManifest };
}

// ============================================================================
// Validation helpers — kept private; expose nothing beyond validateManifest.
// ============================================================================

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every(x => typeof x === 'string');
}

const DELTA_OPS = new Set(['add', 'remove', 'update']);

function validateDeltaArray(v: unknown, fieldName: string): string | null {
    if (v === undefined) return null;
    if (!Array.isArray(v)) return `${fieldName} is not an array`;
    for (let i = 0; i < v.length; i++) {
        const e = v[i];
        if (!isObject(e)) return `${fieldName}[${i}] is not an object`;
        if (typeof e['op'] !== 'string' || !DELTA_OPS.has(e['op'])) return `${fieldName}[${i}].op invalid`;
        if (typeof e['item'] !== 'string') return `${fieldName}[${i}].item missing`;
        const details = e['details'];
        if (details !== undefined && typeof details !== 'string') return `${fieldName}[${i}].details must be string`;
    }
    return null;
}

function validatePlanArray(v: unknown): string | null {
    if (v === undefined) return null;
    if (!Array.isArray(v)) return 'plansDeltas is not an array';
    for (let i = 0; i < v.length; i++) {
        const e = v[i];
        if (!isObject(e)) return `plansDeltas[${i}] is not an object`;
        if (typeof e['op'] !== 'string' || !DELTA_OPS.has(e['op'])) return `plansDeltas[${i}].op invalid`;
        if (typeof e['title'] !== 'string') return `plansDeltas[${i}].title missing`;
        const body = e['body'];
        if (body !== undefined && typeof body !== 'string') return `plansDeltas[${i}].body must be string`;
    }
    return null;
}

function validateSectionArray(v: unknown, fieldName: string): string | null {
    if (v === undefined) return null;
    if (!Array.isArray(v)) return `${fieldName} is not an array`;
    for (let i = 0; i < v.length; i++) {
        const e = v[i];
        if (!isObject(e)) return `${fieldName}[${i}] is not an object`;
        if (typeof e['sectionPath'] !== 'string') return `${fieldName}[${i}].sectionPath missing`;
        if (typeof e['content'] !== 'string') return `${fieldName}[${i}].content missing`;
    }
    return null;
}

function validateCreateArray(v: unknown, fieldName: string): string | null {
    if (v === undefined) return null;
    if (!Array.isArray(v)) return `${fieldName} is not an array`;
    for (let i = 0; i < v.length; i++) {
        const e = v[i];
        if (!isObject(e)) return `${fieldName}[${i}] is not an object`;
        if (typeof e['name'] !== 'string') return `${fieldName}[${i}].name missing`;
        if (typeof e['group'] !== 'string') return `${fieldName}[${i}].group missing`;
        const drafted = e['draftedFields'];
        if (!isObject(drafted)) return `${fieldName}[${i}].draftedFields missing`;
        for (const [k, vv] of Object.entries(drafted)) {
            if (typeof vv !== 'string') return `${fieldName}[${i}].draftedFields[${k}] must be string`;
        }
    }
    return null;
}

function validateDeleteArray(v: unknown, fieldName: string): string | null {
    if (v === undefined) return null;
    if (!Array.isArray(v)) return `${fieldName} is not an array`;
    for (let i = 0; i < v.length; i++) {
        const e = v[i];
        if (!isObject(e)) return `${fieldName}[${i}] is not an object`;
        if (typeof e['name'] !== 'string') return `${fieldName}[${i}].name missing`;
        if (typeof e['reason'] !== 'string') return `${fieldName}[${i}].reason missing`;
    }
    return null;
}

function validateMoveArray(v: unknown, fieldName: string): string | null {
    if (v === undefined) return null;
    if (!Array.isArray(v)) return `${fieldName} is not an array`;
    for (let i = 0; i < v.length; i++) {
        const e = v[i];
        if (!isObject(e)) return `${fieldName}[${i}] is not an object`;
        if (typeof e['name'] !== 'string') return `${fieldName}[${i}].name missing`;
        if (typeof e['toGroup'] !== 'string') return `${fieldName}[${i}].toGroup missing`;
        if (typeof e['reason'] !== 'string') return `${fieldName}[${i}].reason missing`;
    }
    return null;
}

function validateUpdateArray(v: unknown, fieldName: string): string | null {
    if (v === undefined) return null;
    if (!Array.isArray(v)) return `${fieldName} is not an array`;
    for (let i = 0; i < v.length; i++) {
        const e = v[i];
        if (!isObject(e)) return `${fieldName}[${i}] is not an object`;
        if (typeof e['name'] !== 'string') return `${fieldName}[${i}].name missing`;
        const hint = e['reasonHint'];
        if (hint !== undefined && typeof hint !== 'string') return `${fieldName}[${i}].reasonHint must be string`;
    }
    return null;
}
