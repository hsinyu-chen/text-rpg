import { Injectable, inject } from '@angular/core';
import type { LLMContent, LLMProvider, LLMProviderConfig, LLMUsageMetadata } from '@hcs/llm-core';
import { LLMConfigService } from '@app/core/services/llm-config.service';
import { LLMProviderRegistryService } from '@app/core/services/llm-provider-registry.service';
import { ContentParserService } from '@app/core/services/content-parser.service';
import { mergeUsage } from '@app/core/services/llm-usage-merge';
import { findMatchRange } from '@app/core/services/markdown-range-matcher';
import { SaveSettingsStore } from '@app/core/services/multi-agent-save/save-settings.store';

export type HunkFailReason = 'target_not_found' | 'context_mismatch';

export interface HunkAutoFixInput {
    fileName: string;
    sourceContent: string;
    intendedTarget: string;
    intendedReplacement: string;
    context?: string[];
    /** Which side the original validation failed on — steers the prompt. */
    failReason: HunkFailReason;
    signal?: AbortSignal;
    /**
     * Optional stream hooks so a progress dialog can render live CoT and
     * partial structured output. Service stays UI-free — it just forwards
     * stream chunks; the caller decides how to surface them.
     */
    onThoughtChunk?: (text: string) => void;
    onOutputChunk?: (text: string) => void;
    onUsage?: (usage: LLMUsageMetadata) => void;
    /** Fired at the start of each repair round so the UI can label progress. */
    onRoundStart?: (round: number, maxRounds: number) => void;
}

export interface HunkAutoFixOutput {
    target: string;
    replacement: string;
    context: string[];
    /**
     * Whether the final candidate actually matches the source (target + context
     * resolve via {@link findMatchRange}). Empty target/replacement (idempotent
     * "already applied") also counts as matched. False means the internal retry
     * loop ran out of rounds without landing a verbatim match — the caller
     * surfaces that rather than blindly applying.
     */
    matched: boolean;
}

/**
 * How many times we re-prompt the SAME conversation when a candidate still
 * doesn't match. Each round feeds back which side (target vs context) failed
 * plus a verbatim-match reminder. Distinct from the controller's per-button
 * press counter — this is the within-one-conversation retry budget.
 */
const MAX_FIX_ROUNDS = 3;

const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        target: { type: 'string' },
        replacement: { type: 'string' },
        context: { type: 'array', items: { type: 'string' } },
    },
    required: ['target', 'replacement', 'context'],
} as const;

const SYSTEM_INSTRUCTION = `You are repairing a failed text replacement against a markdown knowledge-base file. The user's main LLM emitted a hunk whose target substring and/or context heading-path does not resolve in the source file. Your job: produce a corrected target, replacement, and context so the change can apply.

Definitions:
- "target" is the substring to locate in sourceContent. It MUST appear verbatim — whitespace, punctuation, markdown wrappers (**bold**, *italic*, list markers, indentation) all count.
- "context" is the ordered list of markdown heading titles (outermost → innermost) under which the target lives. It disambiguates an otherwise-ambiguous target and MUST match real heading lines in sourceContent verbatim (without the leading # markers).
- "replacement" is what target becomes; mirror the source's surrounding emphasis/format unless the intended change is explicitly to alter it.

Rules:
- The corrected target MUST appear verbatim in sourceContent, AND must resolve under the given context path.
- Fix BOTH sides as needed — do not assume only one is wrong.
- If the source already reflects the intended state (idempotent), return empty strings for target and replacement, and an empty context array.
- Do NOT invent new content. Only repair what the original hunk intended to express.
- Respond ONLY with the structured JSON object — no prose.`;

interface ParsedCandidate {
    target: string;
    replacement: string;
    context: string[];
}

/**
 * LLM-driven hunk repair for the auto-update dialog. Triggered from a failed
 * match (`target_not_found` — the emitted substring isn't present verbatim — or
 * `context_mismatch` — the substring exists but not under the given heading
 * path). Repairs target + context together, validating each candidate against
 * the source in-loop and re-prompting the SAME conversation (up to
 * {@link MAX_FIX_ROUNDS}) with the specific failure when a candidate still
 * doesn't match.
 *
 * NOT `providedIn: 'root'` — per-instance lifecycle, scoped from the host's
 * providers array (the hunk-list component that drives the repair).
 */
@Injectable()
export class HunkAutoFixService {
    private providerRegistry = inject(LLMProviderRegistryService);
    private llmConfig = inject(LLMConfigService);
    private parser = inject(ContentParserService);
    private settings = inject(SaveSettingsStore);

    readonly maxFixRounds = MAX_FIX_ROUNDS;

    /**
     * Runs the repair conversation. Returns `null` when the LLM call fails, the
     * stream is aborted, or no round produces a parseable response. Otherwise
     * returns the final candidate with a `matched` flag: true when target +
     * context resolve verbatim (or the LLM declared idempotent), false when the
     * retry budget ran out without a match — the caller decides what to do with
     * an unmatched candidate.
     */
    async fix(input: HunkAutoFixInput): Promise<HunkAutoFixOutput | null> {
        const resolved = this.resolveProvider();
        if (!resolved) return null;

        const history: LLMContent[] = [
            { role: 'user', parts: [{ text: this.buildInitialUserText(input) }] },
        ];

        let last: ParsedCandidate | null = null;
        for (let round = 0; round < MAX_FIX_ROUNDS; round++) {
            input.onRoundStart?.(round + 1, MAX_FIX_ROUNDS);

            const output = await this.streamOnce(resolved, history, input);
            if (input.signal?.aborted) return null;
            if (output === null) return last ? { ...last, matched: false } : null;

            const parsed = this.parseCandidate(output);
            if (!parsed) {
                // Unparseable round — feed the model a nudge and try again.
                history.push({ role: 'model', parts: [{ text: output }] });
                history.push({ role: 'user', parts: [{ text: 'Your response was not valid JSON matching the schema. Respond ONLY with {target, replacement, context}.' }] });
                continue;
            }
            last = parsed;

            // Empty target + replacement is the LLM's "already applied" signal.
            if (!parsed.target && !parsed.replacement) {
                return { ...parsed, matched: true };
            }

            if (findMatchRange(input.sourceContent, parsed.target, parsed.context)) {
                return { ...parsed, matched: true };
            }

            // No point appending feedback on the final round — it'd never be sent.
            if (round === MAX_FIX_ROUNDS - 1) break;
            history.push({ role: 'model', parts: [{ text: output }] });
            history.push({ role: 'user', parts: [{ text: this.buildRetryFeedback(parsed, input.sourceContent) }] });
        }

        return last ? { ...last, matched: false } : null;
    }

    private buildInitialUserText(input: HunkAutoFixInput): string {
        const failureNote = input.failReason === 'context_mismatch'
            ? 'Validation result: the target text WAS found verbatim in the file, but NOT under the given context heading path — the context is wrong (or the target is ambiguous and needs a more precise context).'
            : 'Validation result: the target text was NOT found verbatim anywhere in the file — the target string is wrong (whitespace/markdown/punctuation likely differs from the source).';
        return JSON.stringify({
            note: failureNote,
            fileName: input.fileName,
            sourceContent: input.sourceContent,
            intendedTarget: input.intendedTarget,
            intendedReplacement: input.intendedReplacement,
            context: input.context ?? [],
        }, null, 2);
    }

    /**
     * Build the next-round nudge. Re-derives which side is still wrong from the
     * candidate (target present verbatim anywhere ⇒ it's the context that fails;
     * absent ⇒ the target itself fails) so the feedback is grounded in the
     * actual source, not the original failReason.
     */
    private buildRetryFeedback(candidate: ParsedCandidate, source: string): string {
        const targetExistsSomewhere = !!findMatchRange(source, candidate.target);
        const which = targetExistsSomewhere
            ? 'Your target exists in the file, but it still does NOT resolve under your context heading path. Fix the context array to the exact heading titles (verbatim, no # markers) that enclose the target.'
            : 'Your target still does NOT appear verbatim anywhere in the file. Match it character-by-character against sourceContent — whitespace, punctuation, and markdown wrappers (**, *, -, indentation) must be identical.';
        return `That candidate still does not apply. ${which} Return the corrected {target, replacement, context}.`;
    }

    private parseCandidate(raw: string): ParsedCandidate | null {
        const parsed = this.parser.bestEffortJsonParser(raw) as Partial<ParsedCandidate> | null;
        if (!parsed || typeof parsed.target !== 'string' || typeof parsed.replacement !== 'string') {
            console.warn('[HunkAutoFix] Response missing target/replacement strings:', raw);
            return null;
        }
        const context = Array.isArray(parsed.context) ? parsed.context.filter((c): c is string => typeof c === 'string') : [];
        return { target: parsed.target, replacement: parsed.replacement, context };
    }

    /**
     * Streams one LLM turn against `history`, forwarding thought/output/usage
     * chunks. Returns the accumulated structured-output text, or `null` on
     * abort or provider error.
     */
    private async streamOnce(
        resolved: { provider: LLMProvider; config: LLMProviderConfig },
        history: LLMContent[],
        input: HunkAutoFixInput,
    ): Promise<string | null> {
        let accumulator = '';
        let usage: LLMUsageMetadata = { prompt: 0, candidates: 0, cached: 0 };
        try {
            const stream = resolved.provider.generateContentStream(
                resolved.config,
                history,
                SYSTEM_INSTRUCTION,
                {
                    responseSchema: RESPONSE_SCHEMA,
                    responseMimeType: 'application/json',
                    intent: 'hunk_auto_fix',
                    signal: input.signal,
                },
            );
            for await (const chunk of stream) {
                if (chunk.text) {
                    if (chunk.thought) {
                        input.onThoughtChunk?.(chunk.text);
                    } else {
                        accumulator += chunk.text;
                        input.onOutputChunk?.(chunk.text);
                    }
                }
                if (chunk.usageMetadata) {
                    usage = mergeUsage(usage, chunk.usageMetadata);
                    input.onUsage?.(usage);
                }
            }
        } catch (err: unknown) {
            console.warn('[HunkAutoFix] LLM call failed:', err);
            return null;
        }
        return accumulator;
    }

    /**
     * Resolves the provider + config to use for the fix call.
     *
     * - `hunkFixupProfileId` set + profile exists → use that profile's provider
     *   + settings (e.g. user picked a cheap/fast model just for byte-level
     *   repair)
     * - empty or missing profile → fall back to the active main chat profile,
     *   same provider the rest of the app uses
     */
    private resolveProvider(): { provider: LLMProvider; config: LLMProviderConfig } | null {
        const pickedId = this.settings.hunkFixupProfileId();
        if (pickedId) {
            const profile = this.llmConfig.profiles().find(p => p.id === pickedId);
            if (profile) {
                const provider = this.providerRegistry.getProvider(profile.provider);
                if (provider) return { provider, config: profile.settings };
            }
            console.warn(`[HunkAutoFix] Configured profile '${pickedId}' not found; falling back to active.`);
        }
        return this.providerRegistry.getActiveBundle();
    }
}
