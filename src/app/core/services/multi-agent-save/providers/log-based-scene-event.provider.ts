import { Injectable } from '@angular/core';
import { ChatMessage } from '@app/core/models/types';
import { SceneEvent } from '../multi-agent-save.types';
import { extractSceneEvent } from '../utils/extract-scene-event.util';
import { SceneEventOptions, SceneEventProvider } from './scene-event-provider.interface';

/**
 * Default {@link SceneEventProvider} — extracts events from `role: 'model'`
 * chat messages by reading their `summary` / `*_log` fields and the
 * first-line bracket header on `content`.
 *
 * Slice semantics:
 *  - same default ref-only filter as `ContextBuilderService.getLLMHistorySegments`
 *    (drops ref-only messages unless they carry a `functionResponse` part)
 *  - recent-window cap by `saveContextMode`:
 *      'full'         → no cap (every model message in the chat)
 *      'smart'        → last `smartContextTurns * 2` messages
 *      'summarized'   → last 2 messages
 *
 * This does NOT end-to-end mirror `getLLMHistorySegments`. That method
 * returns `[...compressed, ...recent]` where past turns are folded into
 * summary blocks. SceneEvent has no summary equivalent (events are
 * structured per-message and would lose their identity if compressed),
 * so this provider intentionally emits events only from messages in the
 * recent window. Past turns are NOT recoverable as events.
 *
 * For the multi-agent save pipeline that's the right semantics:
 *  - SaveAgent (routing call) sees the full chat history via
 *    `ContextBuilder` snapshot — KV cache makes that cheap
 *  - Stage B-1 (per-entity visibility filter) operates on the recent
 *    window of structured events; older state lives in the entity's KB
 *    card (`目前心態` etc.) which is fed separately
 *
 * Rule of Three: this is the 2nd site that needs save-time recent-window
 * slicing (context-builder's `getLLMHistorySegments` is the 1st). Inlined
 * here pending a 3rd caller — extract a shared helper at that point.
 */
@Injectable({ providedIn: 'root' })
export class LogBasedSceneEventProvider implements SceneEventProvider {
  listEvents(messages: readonly ChatMessage[], options: SceneEventOptions): SceneEvent[] {
    const sliced = this.sliceForSave(messages, options);
    const events: SceneEvent[] = [];
    for (const m of sliced) {
      const ev = extractSceneEvent(m);
      if (ev) events.push(ev);
    }
    return events;
  }

  private sliceForSave(messages: readonly ChatMessage[], options: SceneEventOptions): ChatMessage[] {
    const filtered = messages.filter(m => !m.isRefOnly || m.parts?.some(p => p.functionResponse));

    if (options.saveContextMode === 'full') {
      return filtered;
    }
    const recentWindow = options.saveContextMode === 'summarized' ? 2 : options.smartContextTurns * 2;
    const splitIndex = Math.max(0, filtered.length - recentWindow);
    return filtered.slice(splitIndex);
  }
}
