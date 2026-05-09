import { en } from './dictionaries/en';
import { zhTW } from './dictionaries/zh-tw';

export interface TranslationDict { readonly [key: string]: string | TranslationDict }

export interface UiLocale {
    /** Stable id used as `interfaceLanguage` value and dropdown option key. */
    id: string;
    /** Native-language label shown in the settings dropdown. */
    label: string;
    /**
     * Lowercase prefixes matched against `navigator.language.toLowerCase()`
     * when `interfaceLanguage === 'system'`. First registered locale whose
     * prefix list matches wins; if none match, {@link FALLBACK_UI_LOCALE_ID}
     * is used. Adding a language = push a new entry; resolver code stays put.
     */
    matchPrefixes: readonly string[];
    dictionary: TranslationDict;
}

export const UI_LOCALES = [
    { id: 'zh-TW', label: '繁體中文', matchPrefixes: ['zh'], dictionary: zhTW },
    { id: 'en', label: 'English', matchPrefixes: ['en'], dictionary: en },
] as const satisfies readonly UiLocale[];

export type UiLocaleId = (typeof UI_LOCALES)[number]['id'];

export const FALLBACK_UI_LOCALE_ID: UiLocaleId = 'en';

/**
 * Persisted setting domain. `'system'` means "resolve via navigator at read
 * time" and is the first-class default — not "absent value".
 */
export type InterfaceLanguageSetting = 'system' | UiLocaleId;

/** Valid string values for {@link InterfaceLanguageSetting}, registry-derived. */
export const VALID_INTERFACE_LANGUAGE_VALUES: ReadonlySet<string> =
    new Set<string>(['system', ...UI_LOCALES.map(l => l.id)]);

export function isValidInterfaceLanguage(value: unknown): value is InterfaceLanguageSetting {
    return typeof value === 'string' && VALID_INTERFACE_LANGUAGE_VALUES.has(value);
}
