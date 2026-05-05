import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from './kv/kv-store';

export interface AppConfigShape {
    fontSize?: number;
    fontFamily?: string;
    screensaverType: 'invaders' | 'code';
    currency: string;
    enableConversion: boolean;
    idleOnBlur: boolean;
    enableAdultDeclaration: boolean;
    engineMode: 'single' | 'two-call';
    exchangeRate: number;
    outputLanguage: string;
    smartContextTurns: number;
}

const KEYS = {
    fontSize: 'app_font_size',
    fontFamily: 'app_font_family',
    screensaverType: 'app_screensaver_type',
    currency: 'app_currency',
    enableConversion: 'app_enable_conversion',
    idleOnBlur: 'app_idle_on_blur',
    enableAdultDeclaration: 'app_enable_adult_declaration',
    engineMode: 'app_engine_mode',
    exchangeRate: 'app_exchange_rate',
    outputLanguage: 'app_output_language',
    smartContextTurns: 'app_smart_context_turns',
} as const;

/**
 * Source of truth for general app preferences (fonts, currency, screensaver,
 * engine mode, etc.). Loads on construction from the injected {@link KVStore}
 * and persists changes via {@link patch}. Consumers depend on the per-field
 * signals — no service should reach back into `localStorage` for these keys.
 *
 * Provider-bound LLM settings (api key / model id / cache toggles) live on
 * the active LLM profile, owned by `LLMConfigService` — out of scope here.
 */
@Injectable({ providedIn: 'root' })
export class AppConfigStore {
    private kv = inject(KVStore);

    readonly fontSize = signal<number | undefined>(undefined);
    readonly fontFamily = signal<string | undefined>(undefined);
    readonly screensaverType = signal<'invaders' | 'code'>('invaders');
    readonly currency = signal<string>('TWD');
    readonly enableConversion = signal<boolean>(false);
    readonly idleOnBlur = signal<boolean>(false);
    readonly enableAdultDeclaration = signal<boolean>(true);
    readonly engineMode = signal<'single' | 'two-call'>('single');
    readonly exchangeRate = signal<number>(30);
    readonly outputLanguage = signal<string>('default');
    readonly smartContextTurns = signal<number>(10);

    constructor() {
        this.load();
    }

    private load(): void {
        const sSize = this.kv.get(KEYS.fontSize);
        if (sSize) {
            const n = parseInt(sSize, 10);
            if (Number.isFinite(n)) this.fontSize.set(n);
        }

        const sFamily = this.kv.get(KEYS.fontFamily);
        if (sFamily) this.fontFamily.set(sFamily);

        const sst = this.kv.get(KEYS.screensaverType);
        if (sst === 'invaders' || sst === 'code') this.screensaverType.set(sst);

        const cur = this.kv.get(KEYS.currency);
        if (cur) this.currency.set(cur);

        this.enableConversion.set(this.kv.get(KEYS.enableConversion) === 'true');
        this.idleOnBlur.set(this.kv.get(KEYS.idleOnBlur) === 'true');
        // Mirrors original: opt-OUT semantics (default true unless explicitly 'false').
        this.enableAdultDeclaration.set(this.kv.get(KEYS.enableAdultDeclaration) !== 'false');

        const em = this.kv.get(KEYS.engineMode);
        this.engineMode.set(em === 'two-call' ? 'two-call' : 'single');

        const sRate = this.kv.get(KEYS.exchangeRate);
        if (sRate) {
            const n = parseFloat(sRate);
            if (Number.isFinite(n)) this.exchangeRate.set(n);
        }

        const lang = this.kv.get(KEYS.outputLanguage);
        if (lang) this.outputLanguage.set(lang);

        const sct = this.kv.get(KEYS.smartContextTurns);
        if (sct) {
            const n = parseInt(sct, 10);
            if (Number.isFinite(n)) this.smartContextTurns.set(n);
        }
    }

    /**
     * Apply a partial update. Undefined fields are ignored (they don't clear
     * existing values) — preserving the old `ConfigService.saveConfig`
     * contract where the chat-input's `{ engineMode }` toggle never wiped
     * unrelated fields like fontSize.
     */
    patch(partial: Partial<AppConfigShape>): void {
        if (partial.fontSize !== undefined) {
            this.fontSize.set(partial.fontSize);
            this.kv.set(KEYS.fontSize, String(partial.fontSize));
        }
        if (partial.fontFamily !== undefined) {
            this.fontFamily.set(partial.fontFamily);
            this.kv.set(KEYS.fontFamily, partial.fontFamily);
        }
        if (partial.screensaverType !== undefined) {
            this.screensaverType.set(partial.screensaverType);
            this.kv.set(KEYS.screensaverType, partial.screensaverType);
        }
        if (partial.currency !== undefined) {
            this.currency.set(partial.currency);
            this.kv.set(KEYS.currency, partial.currency);
        }
        if (partial.enableConversion !== undefined) {
            this.enableConversion.set(partial.enableConversion);
            this.kv.set(KEYS.enableConversion, String(partial.enableConversion));
        }
        if (partial.idleOnBlur !== undefined) {
            this.idleOnBlur.set(partial.idleOnBlur);
            this.kv.set(KEYS.idleOnBlur, String(partial.idleOnBlur));
        }
        if (partial.enableAdultDeclaration !== undefined) {
            this.enableAdultDeclaration.set(partial.enableAdultDeclaration);
            this.kv.set(KEYS.enableAdultDeclaration, String(partial.enableAdultDeclaration));
        }
        if (partial.engineMode !== undefined) {
            this.engineMode.set(partial.engineMode);
            this.kv.set(KEYS.engineMode, partial.engineMode);
        }
        if (partial.exchangeRate !== undefined) {
            this.exchangeRate.set(partial.exchangeRate);
            this.kv.set(KEYS.exchangeRate, String(partial.exchangeRate));
        }
        if (partial.outputLanguage !== undefined) {
            this.outputLanguage.set(partial.outputLanguage);
            this.kv.set(KEYS.outputLanguage, partial.outputLanguage);
        }
        if (partial.smartContextTurns !== undefined) {
            this.smartContextTurns.set(partial.smartContextTurns);
            this.kv.set(KEYS.smartContextTurns, String(partial.smartContextTurns));
        }
    }

    /**
     * Snapshot of every field as a plain object — for IDB persistence and
     * one-shot consumers (e.g. settings dialog initial state).
     */
    snapshot(): AppConfigShape {
        return {
            fontSize: this.fontSize(),
            fontFamily: this.fontFamily(),
            screensaverType: this.screensaverType(),
            currency: this.currency(),
            enableConversion: this.enableConversion(),
            idleOnBlur: this.idleOnBlur(),
            enableAdultDeclaration: this.enableAdultDeclaration(),
            engineMode: this.engineMode(),
            exchangeRate: this.exchangeRate(),
            outputLanguage: this.outputLanguage(),
            smartContextTurns: this.smartContextTurns(),
        };
    }
}
