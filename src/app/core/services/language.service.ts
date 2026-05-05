import { Injectable, inject, computed } from '@angular/core';
import { AppConfigStore } from './app-config-store';
import { getLocale } from '../constants/locales';

@Injectable({
    providedIn: 'root'
})
export class LanguageService {
    private appConfig = inject(AppConfigStore);

    // Current locale based on the active output language.
    locale = computed(() => getLocale(this.appConfig.outputLanguage()));

    /**
     * Translates a key from uiStrings.
     * Supports simple placeholder replacement {count}.
     */
    t(key: string, params?: Record<string, string>): string {
        const uiStrings = this.locale().uiStrings as unknown as Record<string, string>;
        let text = uiStrings[key] || key;

        if (params) {
            Object.entries(params).forEach(([k, v]) => {
                text = text.replace(`{${k}}`, v);
            });
        }

        return text;
    }
}
