import { AppLocale } from './locale.interface';
import { EN_US_LOCALE } from './en';
import { ZH_TW_LOCALE } from './zh-tw';

export const LOCALES: Record<string, AppLocale> = {
    'English': EN_US_LOCALE,
    'Traditional Chinese': ZH_TW_LOCALE,
    'default': ZH_TW_LOCALE // Default to Traditional Chinese as per existing system
};

export const getLocale = (lang: string | undefined): AppLocale => {
    if (!lang) return LOCALES['default'];
    if (LOCALES[lang]) return LOCALES[lang];

    // Fallback: search by ID property
    const localeById = Object.values(LOCALES).find(l => l.id === lang);
    return localeById || LOCALES['default'];
};

/**
 * Gets the asset folder name for a given language label.
 */
export const getLangFolder = (lang: string | undefined): string => {
    return getLocale(lang).folder;
};

/**
 * Gets the list of available languages for UI selection.
 */
export const getLanguagesList = () => {
    return [
        { value: 'default', label: 'Default (System Native)' },
        ...Object.entries(LOCALES)
            .filter(([key]) => key !== 'default')
            .map(([key, locale]) => ({
                value: key,
                label: locale.label
            }))
    ];
};
