import { Schema } from '../models/types';
import { getLocale } from './locales';
import { structuredAnalysisSchema } from './engine-protocol-structured';

/**
 * Single-call response schema. Flat shape — `analysis` is now a structured
 * object (see {@link StructuredAnalysis}), not a markdown string. For
 * non-action inputs (`<系統>` general Q&A, `<存檔>`) the model emits a
 * skeleton (empty `steps[]`, empty `scene_snapshot`); the renderer maps that
 * to an empty string for display.
 */
export const getResponseSchema = (lang = 'default'): Schema => {
    const locale = getLocale(lang);
    const { responseSchema } = locale;

    return {
        type: 'object',
        description: responseSchema.rootDescription,
        properties: {
            analysis: structuredAnalysisSchema,
            story: { type: 'string', description: 'The actual story content, system response, or XML Save data.' },
            summary: { type: 'string', description: responseSchema.summary },
            character_log: { type: 'array', items: { type: 'string' }, description: responseSchema.character },
            inventory_log: { type: 'array', items: { type: 'string' }, description: responseSchema.inventory },
            quest_log: { type: 'array', items: { type: 'string' }, description: responseSchema.quest },
            world_log: { type: 'array', items: { type: 'string' }, description: responseSchema.world },
            correction: { type: 'string', description: "Non-empty string ONLY when the user requests a story correction via <系統>. Write 1-2 sentences stating what was wrong AND the corrected rule going forward (e.g., '原劇情誤寫主角穿紅色禮服；實際應為藍色學校制服。後續以藍色制服為準。'). Empty/omitted otherwise." }
        },
        required: ['analysis', 'story', 'summary']
    };
};

export const getCoreFilenames = (lang = 'default') => {
    return getLocale(lang).coreFilenames;
};

export const getSectionHeaders = (lang = 'default') => {
    return getLocale(lang).sectionHeaders;
};

export const getIntentTags = (lang = 'default') => {
    return getLocale(lang).intentTags;
};

export const LLM_MARKERS = {
    FILE_CONTENT_SEPARATOR: '--- 檔案內容',
    SYSTEM_RULE_SEPARATOR: '--- 系統規則'
} as const;

export const getAdultDeclaration = (lang = 'default'): string => {
    return getLocale(lang).adultDeclaration;
};

/**
 * Engine-facing strings tied to {@link AppLocale.engineStrings} — strings the
 * engine writes either as chat-message content (persisted alongside the
 * story) or as prompt content sent back to the LLM. NOT live UI chrome —
 * those live in `src/app/core/i18n/dictionaries/` keyed by `interfaceLanguage`.
 */
export const getEngineStrings = (lang = 'default') => {
    return getLocale(lang).engineStrings;
};

export const INJECTION_FILE_PATHS = {
    action: 'injection_action.md',
    continue: 'injection_continue.md',
    fastforward: 'injection_fastforward.md',
    system: 'injection_system.md',
    save: 'injection_save.md',
    system_main: 'system_prompt.md',
    postprocess: 'postprocess_template.js',
    protocol_single: 'injection_protocol_single.md',
    protocol_resolver: 'injection_protocol_resolver.md',
    protocol_narrator: 'injection_protocol_narrator.md',
    correction: 'injection_correction.md'
} as const;
