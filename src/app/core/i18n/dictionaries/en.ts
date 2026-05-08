import type { TranslationDict } from '../ui-locales';

/**
 * English UI dictionary. Step 1 ships the empty skeleton so the i18n plumbing
 * has a concrete dependency to compile against; Step 3 of the i18n refactor
 * fills in `ui.*` / `intent.*` / `placeholder.*` / `analysis.*` namespaces by
 * migrating fields out of `AppLocale`.
 */
export const en: TranslationDict = {};
