import { InjectionToken } from '@angular/core';
import { CharacterProvider } from './providers/character-provider.interface';
import { FactionProvider } from './providers/faction-provider.interface';
import { SceneEventProvider } from './providers/scene-event-provider.interface';

/**
 * Injection tokens for replaceable multi-agent save data providers.
 *
 * Default bindings are registered in
 * {@link import('./multi-agent-save.providers').MULTI_AGENT_SAVE_PROVIDERS}
 * and pulled into the root injector via app.config.ts. Specs replace either
 * binding with a fake by including a `{ provide: TOKEN, useValue: fake }`
 * entry in `TestBed.configureTestingModule({ providers: [...] })`.
 */
export const CHARACTER_PROVIDER = new InjectionToken<CharacterProvider>('CHARACTER_PROVIDER');
export const FACTION_PROVIDER = new InjectionToken<FactionProvider>('FACTION_PROVIDER');
export const SCENE_EVENT_PROVIDER = new InjectionToken<SceneEventProvider>('SCENE_EVENT_PROVIDER');
