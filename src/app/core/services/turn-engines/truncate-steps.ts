import { ResolverStep } from '../../constants/engine-protocol-two-call';

export interface TruncateResult {
    executed: ResolverStep[];
    interruptedAtStep: number;
    interrupted: boolean;
}

/**
 * Hard-stop truncation at the first `ideal_status === 'broken'` step.
 *
 * The broken step itself is INCLUDED in `executed` — narrator needs it to
 * describe how the precondition broke. Anything after is dropped so the
 * narrator cannot smuggle unexecuted dialogue or actions.
 *
 * `interruptedAtStep` is 1-based to match the resolver schema convention; 0
 * when no break occurred. The resolver also self-reports `interrupted_at_step`
 * but the program recomputes here so the orchestrator never trusts model
 * state when truncating.
 */
export function truncateAtFirstBroken(steps: ResolverStep[]): TruncateResult {
    if (!Array.isArray(steps) || steps.length === 0) {
        return { executed: [], interruptedAtStep: 0, interrupted: false };
    }

    const idx = steps.findIndex(s => s?.ideal_status === 'broken');
    if (idx < 0) {
        return { executed: steps.slice(), interruptedAtStep: 0, interrupted: false };
    }

    return {
        executed: steps.slice(0, idx + 1),
        interruptedAtStep: idx + 1,
        interrupted: true
    };
}
