import { Injectable, computed, inject } from '@angular/core';
import { AppConfigStore } from './app-config-store';
import { getLocale } from '../constants/locales';
import { I18nService } from '../i18n/i18n.service';

@Injectable({
    providedIn: 'root'
})
export class LanguageService {
    private appConfig = inject(AppConfigStore);
    private i18n = inject(I18nService);

    /**
     * Engine-facing locale, keyed by `outputLanguage`. Holds LLM-bound prompt
     * fragments, response schema descriptions, and persisted-as-data labels.
     * UI chrome is *not* here — see {@link I18nService}.
     */
    locale = computed(() => getLocale(this.appConfig.outputLanguage()));

    /**
     * Translate a UI string by its bare key (e.g. `'BATCH_REPLACE'`). Thin
     * wrapper that prefixes `ui.` and delegates to {@link I18nService}, so
     * existing callers stay terse without each importing the i18n module.
     * Bare-key form covers the migrated `uiStrings.*` keys; for non-`ui.*`
     * namespaces (`intent.labels.*`, `placeholder.*`, …) call
     * `i18n.translate(...)` directly.
     */
    t(key: string, params?: Record<string, string | number>): string {
        return this.i18n.translate(`ui.${key}`, params);
    }
}
