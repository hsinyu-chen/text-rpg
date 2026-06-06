import { STORY_INTENTS } from '../constants/game-intents';

/**
 * A stats-enabled Book run in single-call mode can't emit `stat_changes`
 * (that schema field only exists on the two-call resolver). When such a Book
 * tries a story turn in single mode, the engine must offer to switch to
 * two-call before composing — otherwise the ledger silently never updates.
 *
 * Pure predicate so the dispatch decision is unit-testable without standing up
 * the engine's full DI graph. Mirrors the `STORY_INTENTS` filter the two-call
 * dispatch uses in `composeRequest`.
 */
export function needsStatsTwoCallGate(
    hasStatsYaml: boolean,
    engineMode: 'single' | 'two-call',
    intent: string,
): boolean {
    return hasStatsYaml
        && engineMode === 'single'
        && (STORY_INTENTS as string[]).includes(intent);
}

export interface StatsTwoCallGateDeps {
    hasStatsYaml: boolean;
    engineMode: 'single' | 'two-call';
    intent: string;
    /** Opens the confirm dialog; resolves true when the user accepts the switch. */
    confirm: () => Promise<boolean>;
    /** Persists engineMode='two-call' through the normal config path. */
    switchToTwoCall: () => Promise<void>;
}

/**
 * Drives the stats opt-in gate. Returns true to proceed with the turn, false to
 * abort. The collaborators are injected as plain functions so the branching
 * (prompt → switch / decline → abort / no-prompt) is testable without the
 * engine's DI graph.
 *
 * Pure state-driven by design: nothing records that the user was asked, so a
 * later single-mode story turn re-prompts.
 */
export async function runStatsTwoCallGate(deps: StatsTwoCallGateDeps): Promise<boolean> {
    if (!needsStatsTwoCallGate(deps.hasStatsYaml, deps.engineMode, deps.intent)) {
        return true;
    }
    if (!(await deps.confirm())) return false;
    await deps.switchToTwoCall();
    return true;
}
