import { Injectable, inject, computed } from '@angular/core';
import { GameStateService } from './game-state.service';
import { getLocale } from '../constants/locales';

@Injectable({
    providedIn: 'root'
})
export class LanguageService {
    private state = inject(GameStateService);

    // Current locale based on state config
    locale = computed(() => {
        const lang = this.state.config()?.outputLanguage;
        return getLocale(lang);
    });

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
