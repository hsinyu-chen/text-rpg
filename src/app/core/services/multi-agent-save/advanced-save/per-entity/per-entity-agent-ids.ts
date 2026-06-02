/**
 * Stable per-entity agent ids — the `enabledSaveAgents` / `saveAgentProfileIds`
 * keys. Each state agent and its triage agent share the same id so a per-agent
 * profile override applies to both (triage reuses the state agent's profile).
 *
 * Kept in this leaf module so the state agent and the triage agent can both
 * reference the id without importing each other (the state agent injects the
 * triage agent, so a const living on either would be a cycle).
 */
export const CHARACTER_STATE_AGENT_ID = 'character-state';
export const FACTION_STATE_AGENT_ID = 'faction-state';
