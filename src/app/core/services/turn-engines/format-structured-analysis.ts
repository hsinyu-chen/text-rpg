import {
    AnalysisStep,
    KeyObject,
    NpcReaction,
    ObjectReaction,
    PresentNpc,
    SceneSnapshot,
    StructuredAnalysis
} from '@app/core/constants/engine-protocol-structured';

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
export function formatStructuredAnalysis(a: Partial<StructuredAnalysis> | null | undefined): string {
    if (!a) return '';
    const lines: string[] = [];

    if (a.scene_snapshot) {
        const snap = formatSnapshot(a.scene_snapshot);
        if (snap) lines.push(snap);
    }

    const steps = Array.isArray(a.steps) ? a.steps : [];
    const firstBrokenIdx = steps.findIndex(s => s?.breaks_ideal === true);

    steps.forEach((step, idx) => {
        const truncated = firstBrokenIdx >= 0 && idx > firstBrokenIdx;
        const block = formatStep(step, idx + 1, truncated);
        if (block) {
            if (lines.length > 0) lines.push('');
            lines.push(block);
        }
    });

    return lines.join('\n');
}

function formatSnapshot(snap: Partial<SceneSnapshot>): string {
    const lines: string[] = [];

    const dateTime = [snap.date_in_world, snap.time_hhmm].filter(Boolean).join(' ');
    if (dateTime) lines.push(`- 時間: ${dateTime}`);
    if (snap.location) lines.push(`- 地點: ${snap.location}`);
    if (snap.pc_in_header) lines.push(`- 主角: ${snap.pc_in_header}`);
    if (Array.isArray(snap.present_npcs) && snap.present_npcs.length > 0) {
        lines.push(`- 在場NPC: ${snap.present_npcs.map(formatPresentNpc).filter(Boolean).join(', ')}`);
    }
    if (snap.environment) {
        lines.push(`- 環境: ${stripTrailingTerminator(snap.environment)}`);
    }
    if (Array.isArray(snap.key_objects) && snap.key_objects.length > 0) {
        lines.push(`- 重要物件: ${snap.key_objects.map(formatKeyObject).filter(Boolean).join(', ')}`);
    }

    if (lines.length === 0) return '';
    return ['**[現況]**', ...lines].join('\n');
}

/**
 * Renders the resolver's intent inference (`ideal_outcome` + `ideal_strength`)
 * as a short markdown block. Used to prefix the 2-call analysis trace so the
 * user can see how the resolver judged the player's intent before truncation.
 * Returns empty string when both fields are unset.
 */
export function formatResolverIntent(idealOutcome: string | null | undefined, idealStrength: string | null | undefined): string {
    const outcome = idealOutcome?.trim();
    const strength = idealStrength?.trim();
    if (!outcome && !strength) return '';

    const lines: string[] = ['**[意圖判讀]**'];
    if (outcome) lines.push(`- 目標: ${outcome}`);
    if (strength) lines.push(`- 強度: ${strength}`);
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
    if (snap.pc_in_header) charParts.push(snap.pc_in_header);
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

    // Strip any LLM-emitted bracketed line that follows the CFC marker — that slot is now owned by the program.
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

function formatPresentNpc(npc: PresentNpc | null | undefined): string {
    if (!npc?.name) return '';
    return npc.state ? `${npc.name}(${npc.state})` : npc.name;
}

function formatKeyObject(obj: KeyObject | null | undefined): string {
    if (!obj?.name) return '';
    return obj.state ? `${obj.name}(${obj.state})` : obj.name;
}

function formatStep(step: AnalysisStep | null | undefined, ordinal: number, truncated: boolean): string {
    if (!step) return '';

    let icon: string;
    if (truncated) icon = '⏸';
    else if (step.breaks_ideal === true) icon = '🔴';
    else icon = '✅';

    const action = step.action || '(no action)';
    const mood = step.mood ? ` _(${step.mood})_` : '';
    const isEvent = step.kind === 'random_event';
    const header = isEvent ? `**[事件${ordinal}]**` : `**[動作${ordinal}]**`;

    const parts: string[] = [];
    parts.push(`${header} ${icon} ${action}${mood}`);

    if (step.pc_dialogue) {
        parts.push(`   - 主角: "${stripDialogueQuotes(step.pc_dialogue)}"`);
    }

    if (Array.isArray(step.risk_factors) && step.risk_factors.length > 0) {
        parts.push(`   - 風險: ${step.risk_factors.join('; ')}`);
    }

    if (step.outcome) {
        parts.push(`   - 判定: ${step.outcome}`);
    }

    if (truncated) {
        parts.push(`   - _truncated after first break_`);
    }

    const sceneLines: string[] = [];
    if (Array.isArray(step.npc_reactions)) {
        step.npc_reactions.forEach(r => {
            const line = formatNpcReaction(r);
            if (line) sceneLines.push(line);
        });
    }
    if (Array.isArray(step.object_reactions)) {
        step.object_reactions.forEach(r => {
            const line = formatObjectReaction(r);
            if (line) sceneLines.push(line);
        });
    }
    if (sceneLines.length > 0) {
        parts.push(`   - **[全場景${ordinal}]**`);
        sceneLines.forEach(l => parts.push(`     - ${l}`));
    }

    return parts.join('\n');
}

function formatNpcReaction(r: NpcReaction | null | undefined): string {
    if (!r?.actor) return '';
    const segments: string[] = [];
    if (r.physical) segments.push(r.physical);
    if (r.dialogue) segments.push(`「${stripDialogueQuotes(r.dialogue)}」`);
    if (r.motivation) segments.push(`（${r.motivation}）`);
    const body = segments.length > 0 ? segments.join('；') : '(無反應)';
    return `${r.actor}: ${body}`;
}

function formatObjectReaction(r: ObjectReaction | null | undefined): string {
    if (!r?.name) return '';
    return `${r.name}: ${r.change || '無變化'}`;
}
