import { Schema } from '../models/types';
import { getLocale } from './locales';

export const getResponseSchema = (lang = 'default'): Schema => {
    const locale = getLocale(lang);
    const { responseSchema } = locale;

    return {
        type: 'object',
        description: responseSchema.rootDescription,
        properties: {
            analysis: {
                type: 'string',
                description: responseSchema.analysis
            },
            response: {
                type: 'object',
                description: responseSchema.responseDescription,
                properties: {
                    story: { type: 'string', description: "The actual story content, system response, or XML Save data." },
                    summary: { type: 'string', description: responseSchema.summary },
                    inventory_log: { type: 'array', items: { type: 'string' }, description: responseSchema.inventory },
                    quest_log: { type: 'array', items: { type: 'string' }, description: responseSchema.quest },
                    world_log: { type: 'array', items: { type: 'string' }, description: responseSchema.world },
                    isCorrection: { type: 'boolean', description: "Set to true ONLY when the user requests a story correction via <系統>." }
                },
                required: ['story', 'summary']
            }
        },
        required: ['analysis', 'response']
    };
};

export const getCoreFilenames = (lang = 'default') => {
    return getLocale(lang).coreFilenames;
};

export const getSectionHeaders = (lang = 'default') => {
    return getLocale(lang).sectionHeaders;
};

export const getIntentLabels = (lang = 'default') => {
    return getLocale(lang).intentLabels;
};

export const getIntentTags = (lang = 'default') => {
    return getLocale(lang).intentTags;
};

export const getIntentDescriptions = (lang = 'default') => {
    return getLocale(lang).intentDescriptions;
};

export const getInputPlaceholders = (lang = 'default') => {
    return getLocale(lang).inputPlaceholders;
};

export const LLM_MARKERS = {
    FILE_CONTENT_SEPARATOR: '--- 檔案內容',
    SYSTEM_RULE_SEPARATOR: '--- 系統規則'
} as const;

export const getAdultDeclaration = (lang = 'default'): string => {
    return getLocale(lang).adultDeclaration;
};

export const getUIStrings = (lang = 'default') => {
    return getLocale(lang).uiStrings;
};

export const INJECTION_FILE_PATHS = {
    action: 'injection_action.md',
    continue: 'injection_continue.md',
    fastforward: 'injection_fastforward.md',
    system: 'injection_system.md',
    save: 'injection_save.md'
} as const;
