import { Provider } from '@angular/core';
import { CHARACTER_PROVIDER, FACTION_PROVIDER, SCENE_EVENT_PROVIDER } from './multi-agent-save.tokens';
import { MarkdownCharacterProvider } from './providers/markdown-character.provider';
import { MarkdownFactionProvider } from './providers/markdown-faction.provider';
import { LogBasedSceneEventProvider } from './providers/log-based-scene-event.provider';

/**
 * Phase 1 default bindings for multi-agent save data providers.
 *
 * Spread into `app.config.ts` providers. To swap an implementation (e.g.
 * Phase 4 LLM-based character extraction), replace the relevant `useExisting`
 * here — orchestrator and Debug UI inject by token only.
 */
export const MULTI_AGENT_SAVE_PROVIDERS: Provider[] = [
  { provide: CHARACTER_PROVIDER, useExisting: MarkdownCharacterProvider },
  { provide: FACTION_PROVIDER, useExisting: MarkdownFactionProvider },
  { provide: SCENE_EVENT_PROVIDER, useExisting: LogBasedSceneEventProvider },
];
