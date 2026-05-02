import { ResolverOutput, ResolverStep } from '../../constants/engine-protocol-v2';

/**
 * Formats a resolver output (full or partial) as a markdown step trace.
 *
 * The trace is shown in the existing "Atomic Breakdown & Check" panel
 * during the resolver phase of a two-call turn. The first broken step
 * stops the run; later steps in the array are still listed but tagged
 * as truncated so the user can see what the model considered but did
 * not execute.
 */
export function formatResolverTrace(output: Partial<ResolverOutput>): string {
    const lines: string[] = [];

    if (output.ideal_outcome) {
        const strength = output.ideal_strength ? ` _(${output.ideal_strength})_` : '';
        lines.push(`**Ideal outcome:** ${output.ideal_outcome}${strength}`);
        lines.push('');
    }

    const steps = Array.isArray(output.steps) ? output.steps : [];
    if (steps.length === 0) {
        if (lines.length === 0) return '';
        return lines.join('\n');
    }

    const firstBrokenIdx = steps.findIndex(s => s?.ideal_status === 'broken');

    lines.push('**Resolver steps:**');
    lines.push('');

    steps.forEach((step, idx) => {
        const truncated = firstBrokenIdx >= 0 && idx > firstBrokenIdx;
        lines.push(formatStep(step, idx + 1, truncated));
    });

    return lines.join('\n');
}

function formatStep(step: ResolverStep, ordinal: number, truncated: boolean): string {
    if (!step) return '';

    let icon: string;
    if (truncated) icon = '⏸';
    else if (step.ideal_status === 'broken') icon = '🔴';
    else icon = '✅';

    const action = step.action || '(no action)';
    const target = step.target ? ` → ${step.target}` : '';
    const mood = step.mood ? ` _(${step.mood})_` : '';

    const parts: string[] = [];
    parts.push(`${ordinal}. ${icon} **${action}**${target}${mood}`);

    if (step.dialogue) {
        parts.push(`   - 🗣 "${step.dialogue}"`);
    }

    if (step.ideal_status === 'broken' && step.break_reason) {
        parts.push(`   - **broken:** ${step.break_reason}`);
    }

    if (truncated) {
        parts.push(`   - _truncated after first break_`);
    }

    if (Array.isArray(step.npc_reactions) && step.npc_reactions.length > 0) {
        const reacts = step.npc_reactions.map(r => `${r.actor}: ${r.reaction}`).join('; ');
        parts.push(`   - reactions: ${reacts}`);
    }

    return parts.join('\n');
}
