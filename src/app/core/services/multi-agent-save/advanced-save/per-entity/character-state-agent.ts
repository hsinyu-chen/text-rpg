import { Injectable, inject } from '@angular/core';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type { PromptType } from '../../../injection.service';
import { CHARACTER_PROVIDER } from '../../multi-agent-save.tokens';
import { BasePerEntityStateAgent, type PerEntityState } from './base-per-entity-state-agent';

/** Stable agent id — also the `enabledSaveAgents` / `saveAgentProfileIds` key. */
export const CHARACTER_STATE_AGENT_ID = 'character-state';

/**
 * Per-entity state agent for `3.人物狀態.md`. Job B for characters covers
 * physical-state evolution (injury recovery, mindset continuation, off-screen
 * plan progress); the character/faction framing difference lives entirely in
 * the system prompt (`save_character_state`), so this subclass only supplies
 * the wiring the base needs.
 */
@Injectable({ providedIn: 'root' })
export class CharacterStateAgent extends BasePerEntityStateAgent {
    readonly id = CHARACTER_STATE_AGENT_ID;
    readonly i18nKey = 'advancedSaveAgents.characterState';
    protected readonly promptType: PromptType = 'save_character_state';
    protected readonly traceLabel = 'CharacterStateAgent';

    private characterProvider = inject(CHARACTER_PROVIDER);

    protected resolveTargetFile(cf: AppLocale['coreFilenames']): string {
        return cf.CHARACTER_STATUS;
    }

    protected async listEntities(files: ReadonlyMap<string, string>): Promise<PerEntityState[]> {
        return this.characterProvider.listCharacters(files);
    }
}
