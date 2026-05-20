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
    required: ['sectionPath', 'replacement'],
    properties: {
        sectionPath: { type: 'string', description: "Breadcrumb like '# 已開發武器 > ## 短弓改'" },
        target: { type: 'string', description: 'Exact existing substring to replace. Omit to append the replacement at section end.' },
        replacement: { type: 'string', description: 'New content. When target is omitted this is appended at the end of the section.' },
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
    required: ['sectionPath', 'reason'],
    properties: {
        sectionPath: { type: 'string', description: "Full breadcrumb of the L2 entity heading, e.g. '# 核心人物 > ## 李四'" },
        reason: { type: 'string' },
    },
} as const;

const entityMove = {
    type: 'object',
    required: ['fromSectionPath', 'toGroup', 'reason'],
    properties: {
        fromSectionPath: { type: 'string', description: "Current location of the L2 entity, e.g. '# 核心人物 > ## 李四'" },
        toGroup: { type: 'string', description: 'Target L1 group heading text (bare, no leading #)' },
        reason: { type: 'string' },
    },
} as const;

/**
 * Multi-call mode wire for `charactersToUpdate / factionsToUpdate`: only name
 * + optional reasonHint allowed. `additionalProperties: false` (plus the
 * absence of `updates` from the properties map) keeps the main LLM from
 * sneaking diff payloads across the fog-of-war boundary — the per-entity
 * sub-agent (Phase B) is the sole producer of those.
 */
const entityUpdateMulticall = {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
        name: { type: 'string' },
        reasonHint: { type: 'string', description: 'Optional motivation hint — trace only' },
    },
} as const;

/**
 * 1-call mode wire: the main LLM emits a full `updates` payload directly.
 * `updates` is required (an entry that flags an entity but omits updates
 * would be a meaningless ping in this mode); each entry is a SectionUpdate
 * mirroring techEquipmentUpdates et al.
 */
const entityUpdate1Call = {
    type: 'object',
    required: ['name', 'updates'],
    properties: {
        name: { type: 'string' },
        reasonHint: { type: 'string', description: 'Optional motivation hint — trace only' },
        updates: {
            type: 'array',
            minItems: 1,
            description: 'SectionUpdate[] scoped to this entity. Each entry carries its own sectionPath (entity heading path) + target?/replacement, mirroring techEquipmentUpdates etc.',
            items: sectionItem,
        },
    },
} as const;

/**
 * Shared mechanical / lifecycle fields — same shape across 1-call and
 * multi-call modes. Only the entity-update slot diverges, so we splice it in
 * at the per-mode export rather than duplicating ~14 sibling properties.
 *
 * Mirrors the {@link SaveManifest} TypeScript interface field-for-field —
 * when the interface changes, this constant must too; `manifest.schema.spec.ts`
 * guards by parsing schema-shaped fixtures and comparing with hand-rolled
 * TS objects.
 *
 * Kept inline (no `$ref` indirection) — providers vary in how they resolve
 * `$ref`, and the manifest is small enough that inlining wins on clarity.
 *
 * completenessAudit is requested but not in `required` — a truncated response
 * (max_tokens) typically drops the tail of the JSON, and we'd rather salvage
 * the per-section deltas the model did emit than fail the whole manifest.
 * The orchestrator's `finishReason` warning still tells the user the result
 * is partial.
 */
const baseManifestProperties = {
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
} as const;

/**
 * 1-call mode schema: main LLM emits everything including per-entity
 * `updates` payloads. The entity-update items make `updates` required so
 * a model emitting `{ name: 'X' }` alone gets rejected — that shape would
 * silently produce no save work in this mode.
 */
export const SAVE_MANIFEST_SCHEMA_1CALL: Schema = {
    type: 'object',
    description: 'SaveAgent manifest (1-call mode) — main LLM fills every section directly. Dispatcher emits XML mechanically.',
    properties: {
        ...baseManifestProperties,
        charactersToUpdate: { type: 'array', items: entityUpdate1Call },
        factionsToUpdate: { type: 'array', items: entityUpdate1Call },
    },
};

/**
 * Multi-call mode schema: main LLM only flags `name` + `reasonHint` for
 * each entity; the per-entity sub-agent (Phase B) produces the diff under
 * fog-of-war. `additionalProperties: false` on the entity-update items
 * forbids the main LLM from sneaking an `updates` payload into the
 * manifest.
 */
export const SAVE_MANIFEST_SCHEMA_MULTICALL: Schema = {
    type: 'object',
    description: 'SaveAgent manifest (multi-call mode) — main LLM routes only; per-entity sub-agent owns each entity diff.',
    properties: {
        ...baseManifestProperties,
        charactersToUpdate: { type: 'array', items: entityUpdateMulticall },
        factionsToUpdate: { type: 'array', items: entityUpdateMulticall },
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

    // completenessAudit is optional in the validator — see schema comment.
    // When present, validate its inner shape; missing is acceptable for
    // truncated responses.
    const audit = value['completenessAudit'];
    if (audit !== undefined) {
        if (!isObject(audit)) return { ok: false, error: 'completenessAudit is not an object' };
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
        if (typeof e['replacement'] !== 'string') return `${fieldName}[${i}].replacement missing`;
        const target = e['target'];
        if (target !== undefined && typeof target !== 'string') return `${fieldName}[${i}].target must be string`;
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
        if (typeof e['sectionPath'] !== 'string') return `${fieldName}[${i}].sectionPath missing`;
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
        if (typeof e['fromSectionPath'] !== 'string') return `${fieldName}[${i}].fromSectionPath missing`;
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
        const updates = e['updates'];
        if (updates !== undefined) {
            const err = validateSectionArray(updates, `${fieldName}[${i}].updates`);
            if (err) return err;
        }
    }
    return null;
}
