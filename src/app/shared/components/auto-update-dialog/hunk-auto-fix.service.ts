import { Injectable, inject } from '@angular/core';
import type { LLMContent, LLMProvider, LLMProviderConfig, LLMUsageMetadata } from '@hcs/llm-core';
import { LLMConfigService } from '@app/core/services/llm-config.service';
import { LLMProviderRegistryService } from '@app/core/services/llm-provider-registry.service';
import { ContentParserService } from '@app/core/services/content-parser.service';
import { mergeUsage } from '@app/core/services/llm-usage-merge';
import { SaveSettingsStore } from '@app/core/services/multi-agent-save/save-settings.store';

export interface HunkAutoFixInput {
    fileName: string;
    sourceContent: string;
    intendedTarget: string;
    intendedReplacement: string;
    context?: string[];
    signal?: AbortSignal;
    /**
     * Optional stream hooks so a progress dialog can render live CoT and
     * partial structured output. Service stays UI-free — it just forwards
     * stream chunks; the caller decides how to surface them.
     */
    onThoughtChunk?: (text: string) => void;
    onOutputChunk?: (text: string) => void;
    onUsage?: (usage: LLMUsageMetadata) => void;
}

export interface HunkAutoFixOutput {
    target: string;
    replacement: string;
}

const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        target: { type: 'string' },
        replacement: { type: 'string' },
    },
    required: ['target', 'replacement'],
} as const;

const SYSTEM_INSTRUCTION = `You are repairing a failed text replacement. The user's main LLM emitted a target substring that is not present verbatim in the source file. Your job: given the source file and the intended target/replacement, produce a corrected target that IS an exact substring of the source, plus a replacement that preserves the intended change while honouring the source's existing formatting (bold/italic markers, indentation, list markers).

Rules:
- The corrected target MUST appear verbatim in sourceContent (whitespace, punctuation, markdown wrappers all matter).
- The replacement should mirror the source's surrounding emphasis markers unless the intended change is explicitly to remove them.
- If the source already reflects the intended state (idempotent), return empty strings for both target and replacement.
- Do NOT invent new content. Only repair what the original LLM intended to express.
- Respond ONLY with the structured JSON object — no prose.`;

/**
 * LLM-driven hunk repair for the auto-update dialog. Triggered from the
 * `target_not_found` failure state when the main LLM emitted a substring that
 * doesn't appear verbatim in the source file (e.g. dropped a `**bold**`
 * wrapper). Sends the full source + intended hunk to a (optionally separate)
 * profile and parses a structured `{ target, replacement }` back.
 *
 * NOT `providedIn: 'root'` — single-dialog-instance lifecycle, scoped from
 * the dialog's providers array via {@link HunkApplyController}'s scope.
 */
@Injectable()
export class HunkAutoFixService {
    private providerRegistry = inject(LLMProviderRegistryService);
    private llmConfig = inject(LLMConfigService);
    private parser = inject(ContentParserService);
    private settings = inject(SaveSettingsStore);

    /**
     * Runs one repair attempt. Returns `null` when the LLM call fails, the
     * stream is aborted, or the response can't be parsed into the expected
     * shape — the caller surfaces the failure as a snackbar. Empty strings
     * on both fields are a legal "idempotent — nothing to fix" signal and
     * are returned to the caller as-is (not coerced to null).
     */
    async fix(input: HunkAutoFixInput): Promise<HunkAutoFixOutput | null> {
        const resolved = this.resolveProvider();
        if (!resolved) return null;

        const userText = JSON.stringify({
            fileName: input.fileName,
            sourceContent: input.sourceContent,
            intendedTarget: input.intendedTarget,
            intendedReplacement: input.intendedReplacement,
            context: input.context ?? [],
        }, null, 2);

        const history: LLMContent[] = [{ role: 'user', parts: [{ text: userText }] }];

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

        const parsed = this.parser.bestEffortJsonParser(accumulator) as Partial<HunkAutoFixOutput>;
        if (typeof parsed.target !== 'string' || typeof parsed.replacement !== 'string') {
            console.warn('[HunkAutoFix] Response missing target/replacement strings:', accumulator);
            return null;
        }
        return { target: parsed.target, replacement: parsed.replacement };
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
