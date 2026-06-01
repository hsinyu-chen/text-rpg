import { Injectable } from '@angular/core';
import type { PromptType } from '../../../../injection.service';
import { FACTION_STATE_AGENT_ID } from '../per-entity-agent-ids';
import { BaseEntityTriageAgent } from './base-entity-triage-agent';

/**
 * Triage step for the faction state agent — scans all of `6.勢力與世界.md` and
 * selects the factions needing per-entity processing. Shares the
 * `faction-state` id so a per-agent profile override applies to both.
 */
@Injectable({ providedIn: 'root' })
export class FactionTriageAgent extends BaseEntityTriageAgent {
    readonly id = FACTION_STATE_AGENT_ID;
    protected readonly promptType: PromptType = 'save_faction_triage';
    protected readonly traceLabel = 'FactionTriageAgent';
}
