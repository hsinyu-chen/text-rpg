import {
    AnalysisStep,
    KeyObject,
    NpcReaction,
    ObjectReaction,
    PresentNpc,
    SceneSnapshot,
    StructuredAnalysis,
    interruptedAtStep
} from '@app/core/constants/engine-protocol-structured';
import { AppLocale } from '@app/core/constants/locales/locale.interface';
import { getLocale } from '@app/core/constants/locales';

type TraceLabels = AppLocale['analysisTrace'];

/**
 * Renders a {@link StructuredAnalysis} (full or partial — streaming-safe) as
 * markdown for the "Atomic Breakdown & Check" UI panel. Used by both engine
 * modes once they emit StructuredAnalysis.
 *
 * Layout:
 * - 【現況】 line summarizing scene snapshot
 * - 【動作N】 / 【事件N】 + 【全場景N】 paired sections per step
 *   (action vs event marker depends on `step.kind`)
 *
 * Steps after the first `breaks_ideal=true` are still rendered (so the user
 * can see what the model considered) but tagged as truncated. The actual
 * hard-stop slicing is `truncateAtBreak` upstream of the narrator.
 */
export function formatStructuredAnalysis(a: Partial<StructuredAnalysis> | null | undefined, lang?: string): string {
    if (!a) return '';
    const labels = getLocale(lang).analysisTrace;
    const lines: string[] = [];

    if (a.scene_snapshot) {
        const snap = formatSnapshot(a.scene_snapshot, labels);
        if (snap) lines.push(snap);
    }

    const steps = Array.isArray(a.steps) ? a.steps : [];
    const firstBrokenIdx = interruptedAtStep(a) - 1;

    steps.forEach((step, idx) => {
        const truncated = firstBrokenIdx >= 0 && idx > firstBrokenIdx;
        const block = formatStep(step, idx + 1, truncated, labels);
        if (block) {
            if (lines.length > 0) lines.push('');
            lines.push(block);
        }
    });

    return lines.join('\n');
}

function formatSnapshot(snap: Partial<SceneSnapshot>, labels: TraceLabels): string {
    const lines: string[] = [];

    const dateTime = [snap.date_in_world, snap.time_hhmm].filter(Boolean).join(' ');
    if (dateTime) lines.push(`- ${labels.TIME}: ${dateTime}`);
    if (snap.location) lines.push(`- ${labels.LOCATION}: ${snap.location}`);
    const pcHeader = formatPcInHeader(snap);
    if (pcHeader) lines.push(`- ${labels.PROTAGONIST}: ${pcHeader}`);
    if (Array.isArray(snap.present_npcs) && snap.present_npcs.length > 0) {
        lines.push(`- ${labels.PRESENT_NPCS}: ${snap.present_npcs.map(formatPresentNpc).filter(Boolean).join(', ')}`);
    }
    if (snap.environment) {
        lines.push(`- ${labels.ENVIRONMENT}: ${stripTrailingTerminator(snap.environment)}`);
    }
    if (Array.isArray(snap.key_objects) && snap.key_objects.length > 0) {
        lines.push(`- ${labels.KEY_OBJECTS}: ${snap.key_objects.map(formatKeyObject).filter(Boolean).join(', ')}`);
    }

    const physicalLines = formatPhysicalStates(snap);
    if (physicalLines.length > 0) {
        lines.push(`- ${labels.PHYSICAL_STATE}:`);
        physicalLines.forEach(l => lines.push(`  - ${l}`));
    }

    if (lines.length === 0) return '';
    return [`**${labels.SCENE_HEADING}**`, ...lines].join('\n');
}

function formatPhysicalStates(snap: Partial<SceneSnapshot>): string[] {
    const lines: string[] = [];
    const pcName = snap.pc_name?.trim();
    const pcState = snap.pc_state?.trim();
    if (pcName && pcState) lines.push(`${pcName}: ${pcState}`);
    if (Array.isArray(snap.present_npcs)) {
        snap.present_npcs.forEach(n => {
            const name = n?.name?.trim();
            const state = n?.state?.trim();
            if (name && state) lines.push(`${name}: ${state}`);
        });
    }
    return lines;
}

/**
 * Renders the resolver's intent inference (`ideal_outcome` + `ideal_strength`)
 * as a short markdown block. Used to prefix the 2-call analysis trace so the
 * user can see how the resolver judged the player's intent before truncation.
 * Returns empty string when both fields are unset.
 */
export function formatResolverIntent(idealOutcome: string | null | undefined, idealStrength: string | null | undefined, lang?: string): string {
    const outcome = idealOutcome?.trim();
    const strength = idealStrength?.trim();
    if (!outcome && !strength) return '';

    const labels = getLocale(lang).analysisTrace;
    const lines: string[] = [`**${labels.INTENT_HEADING}**`];
    if (outcome) lines.push(`- ${labels.IDEAL_OUTCOME}: ${outcome}`);
    if (strength) lines.push(`- ${labels.IDEAL_STRENGTH}: ${strength}`);
    return lines.join('\n');
}

/**
 * Builds the bracketed scene-header line `[<date> <time> / <location> / <chars>]`
 * from a (possibly partial) scene_snapshot. Returns empty string when the
 * minimum fields (date_in_world / time_hhmm / location) are not yet populated.
 *
 * Note: this does NOT include the `<CREATIVE FICTION CONTEXT>` marker. The
 * marker is a jailbreak signal that MUST be emitted by the LLM itself at the
 * start of `story`; the program only inserts the bracketed line right after it.
 * See {@link assembleStoryWithSceneHeader}.
 */
export function buildSceneHeaderLine(snap: Partial<SceneSnapshot> | null | undefined): string {
    if (!snap) return '';
    const date = snap.date_in_world?.trim();
    const time = snap.time_hhmm?.trim();
    const location = snap.location?.trim();
    if (!date || !time || !location) return '';

    const charParts: string[] = [];
    const pcHeader = formatPcInHeader(snap);
    if (pcHeader) charParts.push(pcHeader);
    if (Array.isArray(snap.present_npcs)) {
        for (const n of snap.present_npcs) {
            const s = formatPresentNpc(n);
            if (s) charParts.push(s);
        }
    }
    const charsLine = charParts.join(', ');

    return `[${date} ${time} / ${location} / ${charsLine}]`;
}

/**
 * Prepends the program-built bracketed scene-header line to the LLM-emitted
 * `story`. The LLM owns the `<CREATIVE FICTION CONTEXT>` jailbreak marker
 * (must come from the LLM's first output token); the program owns the
 * structured header line. Final shape:
 *
 * ```
 * [<date> <time> / <location> / <chars>]
 * <CREATIVE FICTION CONTEXT>
 * <body...>
 * ```
 *
 * If the snapshot is too partial to build a bracket, returns the raw story
 * untouched. Any LLM-emitted bracketed line still living in the body (just
 * after the CFC marker, from older saved-state habits) is stripped so the
 * program-emitted bracket remains the single source of truth.
 */
export function assembleStoryWithSceneHeader(rawStory: string, snap: Partial<SceneSnapshot> | null | undefined): string {
    const inner = buildSceneHeaderLine(snap);
    if (!inner) return rawStory;

    const cleaned = rawStory.replace(/(<CREATIVE FICTION CONTEXT>\s*)\[[^\]]*\]\s*/i, '$1');
    return `${inner}\n\n${cleaned}`;
}

/** Removes a single trailing period (CJK or ASCII) so the segment-joining `。` doesn't produce `。。`. */
function stripTrailingTerminator(s: string): string {
    return s.replace(/[。.]+$/, '');
}

/**
 * Strips any pair of matching dialogue quotes the model may have included on the dialogue value.
 * The renderer always re-wraps in 「」, so a model-emitted line like 「太好了」 would otherwise display
 * as 「「太好了」」.
 */
function stripDialogueQuotes(s: string): string {
    const trimmed = s.trim();
    const pairs: [string, string][] = [['「', '」'], ['『', '』'], ['"', '"'], ['"', '"'], ["'", "'"]];
    for (const [open, close] of pairs) {
        if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length >= open.length + close.length) {
            return trimmed.slice(open.length, trimmed.length - close.length);
        }
    }
    return trimmed;
}

function formatPcInHeader(snap: Partial<SceneSnapshot>): string {
    if (!snap.pc_name) return '';
    const alias = snap.pc_alias ? `[${snap.pc_alias}]` : '';
    const awareness = snap.pc_awareness ? `(${snap.pc_awareness})` : '';
    return `${snap.pc_name}${alias}${awareness}`;
}

function formatPresentNpc(npc: PresentNpc | null | undefined): string {
    if (!npc?.name) return '';
    return npc.awareness ? `${npc.name}(${npc.awareness})` : npc.name;
}

function formatKeyObject(obj: KeyObject | null | undefined): string {
    if (!obj?.name) return '';
    return obj.state ? `${obj.name}(${obj.state})` : obj.name;
}

function formatStep(step: AnalysisStep | null | undefined, ordinal: number, truncated: boolean, labels: TraceLabels): string {
    if (!step) return '';

    let icon: string;
    if (truncated) icon = '⏸';
    else if (step.breaks_ideal === true) icon = '🔴';
    else icon = '✅';

    const action = step.action || labels.NO_ACTION;
    const mood = step.mood ? ` _(${step.mood})_` : '';
    const isEvent = step.kind === 'random_event';
    const stepLabel = isEvent ? labels.STEP_EVENT : labels.STEP_ACTION;
    const header = `**[${stepLabel}${ordinal}]**`;

    const parts: string[] = [];
    parts.push(`${header} ${icon} ${action}${mood}`);

    if (step.pc_dialogue) {
        parts.push(`   - ${labels.PC_DIALOGUE}: "${stripDialogueQuotes(step.pc_dialogue)}"`);
    }

    if (Array.isArray(step.risk_factors) && step.risk_factors.length > 0) {
        parts.push(`   - ${labels.RISKS}: ${step.risk_factors.join('; ')}`);
    }

    if (step.outcome) {
        parts.push(`   - ${labels.OUTCOME}: ${step.outcome}`);
    }

    if (truncated) {
        parts.push(`   - _${labels.TRUNCATED_NOTE}_`);
    }

    const sceneLines: string[] = [];
    if (Array.isArray(step.npc_reactions)) {
        step.npc_reactions.forEach(r => {
            const line = formatNpcReaction(r, labels);
            if (line) sceneLines.push(line);
        });
    }
    if (Array.isArray(step.object_reactions)) {
        step.object_reactions.forEach(r => {
            const line = formatObjectReaction(r, labels);
            if (line) sceneLines.push(line);
        });
    }
    if (sceneLines.length > 0) {
        parts.push(`   - **[${labels.FULL_SCENE}${ordinal}]**`);
        sceneLines.forEach(l => parts.push(`     - ${l}`));
    }

    if (step.scene_change && step.scene_change.trim().length > 0) {
        parts.push(`   - **[${labels.SCENE_CHANGE}]** ${step.scene_change.trim()}`);
    }

    return parts.join('\n');
}

function formatNpcReaction(r: NpcReaction | null | undefined, labels: TraceLabels): string {
    if (!r?.actor) return '';
    const segments: string[] = [];
    if (r.physical) segments.push(r.physical);
    if (r.dialogue) segments.push(`「${stripDialogueQuotes(r.dialogue)}」`);
    if (r.motivation) segments.push(`（${r.motivation}）`);
    const body = segments.length > 0 ? segments.join('；') : labels.NO_REACTION;
    return `${r.actor}: ${body}`;
}

function formatObjectReaction(r: ObjectReaction | null | undefined, labels: TraceLabels): string {
    if (!r?.name) return '';
    return `${r.name}: ${r.change || labels.NO_CHANGE}`;
}
