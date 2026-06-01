import { Injectable } from '@angular/core';
import type { PromptType } from '../../../../injection.service';
import { CHARACTER_STATE_AGENT_ID } from '../per-entity-agent-ids';
import { BaseEntityTriageAgent } from './base-entity-triage-agent';

/**
 * Triage step for the character state agent — scans all of `3.人物狀態.md` and
 * selects the characters needing per-entity processing. Shares the
 * `character-state` id so a per-agent profile override applies to both.
 */
@Injectable({ providedIn: 'root' })
export class CharacterTriageAgent extends BaseEntityTriageAgent {
    readonly id = CHARACTER_STATE_AGENT_ID;
    protected readonly promptType: PromptType = 'save_character_triage';
    protected readonly traceLabel = 'CharacterTriageAgent';
}
