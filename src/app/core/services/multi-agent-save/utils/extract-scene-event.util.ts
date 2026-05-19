import { ChatMessage } from '@app/core/models/types';
import { SceneEvent } from '../multi-agent-save.types';

/**
 * First-line bracket header detection — mirrors the regex in
 * `ContextBuilderService.getLLMHistorySegments` (looks for the first
 * `[...digit...]` token on the message content). Same character class so a
 * model output that satisfies one path satisfies the other.
 */
const SCENE_HEADER_RE = /\[\s*[^\]]*\d+[^\]]*\]/;

/**
 * Extract a {@link SceneEvent} from a single chat message. Returns `null`
 * when the message carries no narrative payload — i.e. all four `*_log`
 * arrays are empty AND `summary` is blank. Such messages exist (system
 * acknowledgements, reference-only echoes) and would be noise in the
 * Visibility Tagger's input.
 *
 * `user` messages are also rejected — only model turns advance the world.
 */
export function extractSceneEvent(msg: ChatMessage): SceneEvent | null {
  if (msg.role !== 'model') return null;

  const character_log = msg.character_log ?? [];
  const inventory_log = msg.inventory_log ?? [];
  const quest_log = msg.quest_log ?? [];
  const world_log = msg.world_log ?? [];
  const summary = msg.summary?.trim() ?? '';

  const hasPayload =
    summary.length > 0 ||
    character_log.length > 0 ||
    inventory_log.length > 0 ||
    quest_log.length > 0 ||
    world_log.length > 0;
  if (!hasPayload) return null;

  const headerMatch = msg.content?.match(SCENE_HEADER_RE);
  const sceneHeader = headerMatch ? headerMatch[0] : '';

  return {
    eventId: msg.id.slice(0, 8),
    messageId: msg.id,
    sceneHeader,
    summary,
    character_log: [...character_log],
    inventory_log: [...inventory_log],
    quest_log: [...quest_log],
    world_log: [...world_log],
  };
}
