import type { ChatMessage } from '@app/core/models/types';

/**
 * Slice messages from the most recent `--- ACT START ---` marker onward —
 * the boundary the SaveAgent's prompt scopes to. Falls back to the full list
 * when the marker is absent (early-session edge cases).
 */
export function sliceToActStart(messages: readonly ChatMessage[]): ChatMessage[] {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].content?.includes('--- ACT START ---')) {
            return messages.slice(i);
        }
    }
    return [...messages];
}

/** A `*_log` field on {@link ChatMessage} plus the label it renders under. */
export interface ActLogKind {
    key: 'character_log' | 'inventory_log' | 'world_log' | 'quest_log';
    label: string;
}

/**
 * Render the chosen `*_log` entries across the given messages as a compact
 * digest grouped by message id — the ground-truth anchor an advanced-save
 * agent verifies hunks against. Each agent picks which log kinds matter to it
 * (inventory agent: inventory + world; per-entity character agent: character +
 * world). Messages with no entry in any chosen kind are skipped.
 */
export function renderActLogDigest(messages: readonly ChatMessage[], kinds: readonly ActLogKind[]): string {
    const lines: string[] = [];
    for (const m of messages) {
        const groups = kinds
            .map(k => ({ label: k.label, entries: m[k.key] ?? [] }))
            .filter(g => g.entries.length > 0);
        if (groups.length === 0) continue;
        lines.push(`message ${m.id}:`);
        for (const g of groups) {
            for (const e of g.entries) lines.push(`  [${g.label}] ${e}`);
        }
    }
    const labels = kinds.map(k => k.label).join(' or ');
    return lines.length ? lines.join('\n') : `(no ${labels} log entries in this ACT)`;
}
