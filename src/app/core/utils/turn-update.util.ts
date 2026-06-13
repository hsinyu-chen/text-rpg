import { ChatMessage } from '@app/core/models/types';

/**
 * True when a message carries any turn-update content: a summary, any of the
 * four logs, or a correction. Numeric-stat changes are tracked separately
 * (via StatsViewService) and are intentionally NOT considered here.
 */
export function hasTurnUpdate(m: ChatMessage | null | undefined): boolean {
    return !!(m && (m.summary
        || (m.character_log?.length ?? 0) > 0
        || (m.inventory_log?.length ?? 0) > 0
        || (m.quest_log?.length ?? 0) > 0
        || (m.world_log?.length ?? 0) > 0
        || m.correction));
}
