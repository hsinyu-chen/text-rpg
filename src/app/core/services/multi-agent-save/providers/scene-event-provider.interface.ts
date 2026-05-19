import { ChatMessage } from '@app/core/models/types';
import { SceneEvent } from '../multi-agent-save.types';

/**
 * Options for {@link SceneEventProvider.listEvents}. Mirrors the
 * save-time slicing that {@link import('@app/core/services/context-builder.service').ContextBuilderService}
 * applies to chat history — passing the same `saveContextMode` /
 * `smartContextTurns` here keeps multi-agent save's event view in lockstep
 * with what the legacy 1-call save would see.
 */
export interface SceneEventOptions {
  saveContextMode: 'full' | 'smart' | 'summarized';
  smartContextTurns: number;
}

/**
 * Source of `SceneEvent[]` for Stage B-1 (Visibility Tagger).
 *
 * Phase 1 default: {@link import('./log-based-scene-event.provider').LogBasedSceneEventProvider}
 * — extracts events from `role: 'model'` chat messages by reading their
 * `summary` / `*_log` fields and the first-line bracket header on `content`.
 *
 * Future: if the engine ever emits a structured event stream alongside chat,
 * a `StructuredEventProvider` can replace this without touching the
 * orchestrator.
 */
export interface SceneEventProvider {
  /**
   * Return type is `T | PromiseLike<T>` so sync implementations (Phase 1
   * log-based) don't need a `Promise.resolve` wrap, while async ones
   * (a future structured-stream fetcher, or LLM-driven event distillation)
   * plug in without a breaking signature change. Callers always `await`.
   */
  listEvents(
    messages: readonly ChatMessage[],
    options: SceneEventOptions
  ): SceneEvent[] | PromiseLike<SceneEvent[]>;
}
