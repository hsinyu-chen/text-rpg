import { Injectable, inject, signal } from '@angular/core';
import { isValidInterfaceLanguage, type InterfaceLanguageSetting } from '../i18n/ui-locales';
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
    /** LLM-facing story language. Open set — accepts custom strings the model can write. */
    outputLanguage: string;
    /**
     * UI-facing language. Closed set: `'system'` ∪ registered {@link UiLocaleId}.
     * `'system'` means "resolve via navigator at read time" — first-class default,
     * not "absent value". Resolution lives in {@link I18nService}.
     */
    interfaceLanguage: InterfaceLanguageSetting;
    smartContextTurns: number;
    contextMode: ContextMode;
    saveContextMode: ContextMode;
}

export type ContextMode = 'smart' | 'full' | 'summarized';

function isContextMode(v: unknown): v is ContextMode {
    return v === 'smart' || v === 'full' || v === 'summarized';
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
    interfaceLanguage: 'app_interface_language',
    smartContextTurns: 'app_smart_context_turns',
    contextMode: 'app_context_mode',
    saveContextMode: 'app_save_context_mode',
} as const;

function parseInterfaceLanguage(raw: string | null): InterfaceLanguageSetting {
    return isValidInterfaceLanguage(raw) ? raw : 'system';
}

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

    // Internal writable signals — only the store's own load/patch can mutate.
    private _fontSize = signal<number | undefined>(undefined);
    private _fontFamily = signal<string | undefined>(undefined);
    private _screensaverType = signal<'invaders' | 'code'>('invaders');
    private _currency = signal<string>('TWD');
    private _enableConversion = signal<boolean>(false);
    private _idleOnBlur = signal<boolean>(false);
    private _enableAdultDeclaration = signal<boolean>(true);
    private _engineMode = signal<'single' | 'two-call'>('single');
    private _exchangeRate = signal<number>(30);
    private _outputLanguage = signal<string>('default');
    private _interfaceLanguage = signal<InterfaceLanguageSetting>('system');
    private _smartContextTurns = signal<number>(10);
    private _contextMode = signal<ContextMode>('smart');
    private _saveContextMode = signal<ContextMode>('smart');

    // Public read-only views. Consumers can subscribe / read but cannot
    // bypass `patch()` to write back without the matching KV sync.
    readonly fontSize = this._fontSize.asReadonly();
    readonly fontFamily = this._fontFamily.asReadonly();
    readonly screensaverType = this._screensaverType.asReadonly();
    readonly currency = this._currency.asReadonly();
    readonly enableConversion = this._enableConversion.asReadonly();
    readonly idleOnBlur = this._idleOnBlur.asReadonly();
    readonly enableAdultDeclaration = this._enableAdultDeclaration.asReadonly();
    readonly engineMode = this._engineMode.asReadonly();
    readonly exchangeRate = this._exchangeRate.asReadonly();
    readonly outputLanguage = this._outputLanguage.asReadonly();
    readonly interfaceLanguage = this._interfaceLanguage.asReadonly();
    readonly smartContextTurns = this._smartContextTurns.asReadonly();
    readonly contextMode = this._contextMode.asReadonly();
    readonly saveContextMode = this._saveContextMode.asReadonly();

    constructor() {
        this.load();
    }

    private load(): void {
        const sSize = this.kv.get(KEYS.fontSize);
        if (sSize) {
            const n = parseInt(sSize, 10);
            if (Number.isFinite(n)) this._fontSize.set(n);
        }

        const sFamily = this.kv.get(KEYS.fontFamily);
        if (sFamily) this._fontFamily.set(sFamily);

        const sst = this.kv.get(KEYS.screensaverType);
        if (sst === 'invaders' || sst === 'code') this._screensaverType.set(sst);

        const cur = this.kv.get(KEYS.currency);
        if (cur) this._currency.set(cur);

        this._enableConversion.set(this.kv.get(KEYS.enableConversion) === 'true');
        this._idleOnBlur.set(this.kv.get(KEYS.idleOnBlur) === 'true');
        // Mirrors original: opt-OUT semantics (default true unless explicitly 'false').
        this._enableAdultDeclaration.set(this.kv.get(KEYS.enableAdultDeclaration) !== 'false');

        const em = this.kv.get(KEYS.engineMode);
        this._engineMode.set(em === 'two-call' ? 'two-call' : 'single');

        const sRate = this.kv.get(KEYS.exchangeRate);
        if (sRate) {
            const n = parseFloat(sRate);
            if (Number.isFinite(n)) this._exchangeRate.set(n);
        }

        const lang = this.kv.get(KEYS.outputLanguage);
        if (lang) this._outputLanguage.set(lang);

        this._interfaceLanguage.set(parseInterfaceLanguage(this.kv.get(KEYS.interfaceLanguage)));

        const sct = this.kv.get(KEYS.smartContextTurns);
        if (sct) {
            const n = parseInt(sct, 10);
            if (Number.isFinite(n)) this._smartContextTurns.set(n);
        }

        const cm = this.kv.get(KEYS.contextMode);
        if (isContextMode(cm)) this._contextMode.set(cm);

        const scm = this.kv.get(KEYS.saveContextMode);
        if (isContextMode(scm)) this._saveContextMode.set(scm);
    }

    /**
     * Apply a partial update. Undefined fields are ignored (they don't clear
     * existing values) — preserving the old `ConfigService.saveConfig`
     * contract where the chat-input's `{ engineMode }` toggle never wiped
     * unrelated fields like fontSize.
     */
    patch(partial: Partial<AppConfigShape>): void {
        if (partial.fontSize !== undefined) {
            this._fontSize.set(partial.fontSize);
            this.kv.set(KEYS.fontSize, String(partial.fontSize));
        }
        if (partial.fontFamily !== undefined) {
            this._fontFamily.set(partial.fontFamily);
            this.kv.set(KEYS.fontFamily, partial.fontFamily);
        }
        if (partial.screensaverType !== undefined) {
            this._screensaverType.set(partial.screensaverType);
            this.kv.set(KEYS.screensaverType, partial.screensaverType);
        }
        if (partial.currency !== undefined) {
            this._currency.set(partial.currency);
            this.kv.set(KEYS.currency, partial.currency);
        }
        if (partial.enableConversion !== undefined) {
            this._enableConversion.set(partial.enableConversion);
            this.kv.set(KEYS.enableConversion, String(partial.enableConversion));
        }
        if (partial.idleOnBlur !== undefined) {
            this._idleOnBlur.set(partial.idleOnBlur);
            this.kv.set(KEYS.idleOnBlur, String(partial.idleOnBlur));
        }
        if (partial.enableAdultDeclaration !== undefined) {
            this._enableAdultDeclaration.set(partial.enableAdultDeclaration);
            this.kv.set(KEYS.enableAdultDeclaration, String(partial.enableAdultDeclaration));
        }
        if (partial.engineMode !== undefined) {
            this._engineMode.set(partial.engineMode);
            this.kv.set(KEYS.engineMode, partial.engineMode);
        }
        if (partial.exchangeRate !== undefined) {
            this._exchangeRate.set(partial.exchangeRate);
            this.kv.set(KEYS.exchangeRate, String(partial.exchangeRate));
        }
        if (partial.outputLanguage !== undefined) {
            this._outputLanguage.set(partial.outputLanguage);
            this.kv.set(KEYS.outputLanguage, partial.outputLanguage);
        }
        if (partial.interfaceLanguage !== undefined) {
            this._interfaceLanguage.set(partial.interfaceLanguage);
            this.kv.set(KEYS.interfaceLanguage, partial.interfaceLanguage);
        }
        if (partial.smartContextTurns !== undefined) {
            this._smartContextTurns.set(partial.smartContextTurns);
            this.kv.set(KEYS.smartContextTurns, String(partial.smartContextTurns));
        }
        if (partial.contextMode !== undefined) {
            this._contextMode.set(partial.contextMode);
            this.kv.set(KEYS.contextMode, partial.contextMode);
        }
        if (partial.saveContextMode !== undefined) {
            this._saveContextMode.set(partial.saveContextMode);
            this.kv.set(KEYS.saveContextMode, partial.saveContextMode);
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
            interfaceLanguage: this.interfaceLanguage(),
            smartContextTurns: this.smartContextTurns(),
            contextMode: this.contextMode(),
            saveContextMode: this.saveContextMode(),
        };
    }
}
