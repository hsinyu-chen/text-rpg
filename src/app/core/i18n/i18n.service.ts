import { Injectable, computed, inject } from '@angular/core';
import { AppConfigStore } from '../services/app-config-store';
import { WINDOW } from '../tokens/window.token';
import {
    FALLBACK_UI_LOCALE_ID,
    UI_LOCALES,
    type TranslationDict,
    type UiLocaleId,
} from './ui-locales';

@Injectable({ providedIn: 'root' })
export class I18nService {
    private appConfig = inject(AppConfigStore);
    private window = inject(WINDOW);

    /** Resolved active language. Tracks `interfaceLanguage` and resolves `'system'`. */
    readonly currentLang = computed<UiLocaleId>(() => {
        const setting = this.appConfig.interfaceLanguage();
        return setting === 'system' ? this.resolveSystemLang() : setting;
    });

    /**
     * Look up a dotted-key string in the active dictionary. Falls back to the
     * key itself on miss — surfaces typos visibly in the UI without throwing.
     * Params replace `{{name}}` placeholders.
     */
    translate(key: string, params?: Record<string, string | number>): string {
        const dict = UI_LOCALES.find(l => l.id === this.currentLang())?.dictionary ?? {};
        const value = this.walk(dict, key);
        if (typeof value !== 'string') return key;

        if (!params) return value;
        let out = value;
        for (const p in params) {
            out = out.replace(new RegExp(`{{\\s*${p}\\s*}}`, 'g'), String(params[p]));
        }
        return out;
    }

    private walk(dict: TranslationDict, key: string): string | TranslationDict | undefined {
        let value: string | TranslationDict | undefined = dict;
        for (const k of key.split('.')) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k];
            } else {
                return undefined;
            }
        }
        return value;
    }

    private resolveSystemLang(): UiLocaleId {
        const browser = this.window.navigator.language.toLowerCase();
        return UI_LOCALES.find(l => l.matchPrefixes.some(p => browser.startsWith(p)))?.id
            ?? FALLBACK_UI_LOCALE_ID;
    }
}
