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
 * Slicing logic mirrors `ContextBuilderService.getLLMHistorySegments`:
 *  - apply the same default filter (drop ref-only messages unless they
 *    carry tool responses) so the event view tracks what legacy save sees
 *  - then a window cap by `saveContextMode`:
 *      'full'         → no cap
 *      'smart'        → last `smartContextTurns * 2` messages
 *      'summarized'   → last 2 messages
 *
 * Rule of Three: this is the 2nd site that needs the save-time slice
 * (context-builder's `getLLMHistorySegments` is the 1st). Inlined here
 * pending a 3rd caller — keep this comment so a future occurrence knows
 * to extract a shared helper instead of growing a third copy.
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
