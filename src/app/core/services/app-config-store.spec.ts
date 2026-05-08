import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AppConfigStore } from './app-config-store';
import { KVStore } from './kv/kv-store';
import { InMemoryKVStore } from '../testing/in-memory-kv-store';

function setup(seed: Record<string, string> = {}): { store: AppConfigStore; kv: InMemoryKVStore } {
    // Reset between calls so tests can build multiple stores in one `it`.
    TestBed.resetTestingModule();
    const kv = new InMemoryKVStore(seed);
    TestBed.configureTestingModule({
        providers: [{ provide: KVStore, useValue: kv }],
    });
    return { store: TestBed.inject(AppConfigStore), kv };
}

describe('AppConfigStore.load', () => {
    it('falls back to defaults when KV is empty', () => {
        const { store } = setup();
        expect(store.fontSize()).toBeUndefined();
        expect(store.fontFamily()).toBeUndefined();
        expect(store.screensaverType()).toBe('invaders');
        expect(store.currency()).toBe('TWD');
        expect(store.enableConversion()).toBe(false);
        expect(store.idleOnBlur()).toBe(false);
        expect(store.enableAdultDeclaration()).toBe(true);
        expect(store.engineMode()).toBe('single');
        expect(store.exchangeRate()).toBe(30);
        expect(store.outputLanguage()).toBe('default');
        expect(store.interfaceLanguage()).toBe('system');
        expect(store.smartContextTurns()).toBe(10);
    });

    it('accepts registered interfaceLanguage ids and falls back to system on garbage', () => {
        expect(setup({ app_interface_language: 'system' }).store.interfaceLanguage()).toBe('system');
        expect(setup({ app_interface_language: 'zh-TW' }).store.interfaceLanguage()).toBe('zh-TW');
        expect(setup({ app_interface_language: 'en' }).store.interfaceLanguage()).toBe('en');
        // Unknown id (e.g. removed locale) falls back to system rather than locking the user
        // into a missing dictionary.
        expect(setup({ app_interface_language: 'klingon' }).store.interfaceLanguage()).toBe('system');
    });

    it('parses numeric fields and ignores garbage', () => {
        const { store } = setup({
            app_font_size: '14',
            app_exchange_rate: '32.5',
            app_smart_context_turns: 'not-a-number',
        });
        expect(store.fontSize()).toBe(14);
        expect(store.exchangeRate()).toBe(32.5);
        // Garbage falls through to default rather than NaN
        expect(store.smartContextTurns()).toBe(10);
    });

    it('treats enableAdultDeclaration as opt-OUT (default true unless explicit false)', () => {
        expect(setup({}).store.enableAdultDeclaration()).toBe(true);
        expect(setup({ app_enable_adult_declaration: 'true' }).store.enableAdultDeclaration()).toBe(true);
        expect(setup({ app_enable_adult_declaration: 'false' }).store.enableAdultDeclaration()).toBe(false);
        // Anything other than literal 'false' keeps the opt-in default.
        expect(setup({ app_enable_adult_declaration: '0' }).store.enableAdultDeclaration()).toBe(true);
    });

    it('rejects unknown enum values for screensaverType / engineMode', () => {
        const { store } = setup({
            app_screensaver_type: 'matrix',
            app_engine_mode: 'three-call',
        });
        expect(store.screensaverType()).toBe('invaders');
        expect(store.engineMode()).toBe('single');
    });

    it('accepts the valid enum values', () => {
        const { store } = setup({
            app_screensaver_type: 'code',
            app_engine_mode: 'two-call',
        });
        expect(store.screensaverType()).toBe('code');
        expect(store.engineMode()).toBe('two-call');
    });
});

describe('AppConfigStore.patch', () => {
    it('updates signals and persists to KV in lock-step', () => {
        const { store, kv } = setup();
        store.patch({ outputLanguage: 'zh-tw', fontSize: 16 });
        expect(store.outputLanguage()).toBe('zh-tw');
        expect(store.fontSize()).toBe(16);
        expect(kv.get('app_output_language')).toBe('zh-tw');
        expect(kv.get('app_font_size')).toBe('16');
    });

    it('ignores undefined keys (partial-update contract)', () => {
        const { store, kv } = setup({ app_font_size: '12' });
        store.patch({ outputLanguage: 'ja' });
        // fontSize stays at the seeded value; not wiped by an absent key.
        expect(store.fontSize()).toBe(12);
        expect(kv.get('app_font_size')).toBe('12');
        expect(store.outputLanguage()).toBe('ja');
    });

    it('serializes booleans and numbers to strings', () => {
        const { store, kv } = setup();
        store.patch({ enableConversion: true, exchangeRate: 31.7, smartContextTurns: 8 });
        expect(kv.get('app_enable_conversion')).toBe('true');
        expect(kv.get('app_exchange_rate')).toBe('31.7');
        expect(kv.get('app_smart_context_turns')).toBe('8');
    });
});

describe('AppConfigStore.snapshot', () => {
    it('returns the current values of every field', () => {
        const { store } = setup({ app_currency: 'USD', app_idle_on_blur: 'true' });
        store.patch({ outputLanguage: 'en' });
        expect(store.snapshot()).toEqual({
            fontSize: undefined,
            fontFamily: undefined,
            screensaverType: 'invaders',
            currency: 'USD',
            enableConversion: false,
            idleOnBlur: true,
            enableAdultDeclaration: true,
            engineMode: 'single',
            exchangeRate: 30,
            outputLanguage: 'en',
            interfaceLanguage: 'system',
            smartContextTurns: 10,
        });
    });
});
