import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SaveSettingsStore } from './save-settings.store';
import { KVStore } from '../kv/kv-store';
import { InMemoryKVStore } from '../../testing/in-memory-kv-store';

function setup(seed: Record<string, string> = {}): { store: SaveSettingsStore; kv: InMemoryKVStore } {
    TestBed.resetTestingModule();
    const kv = new InMemoryKVStore(seed);
    TestBed.configureTestingModule({
        providers: [{ provide: KVStore, useValue: kv }],
    });
    return { store: TestBed.inject(SaveSettingsStore), kv };
}

describe('SaveSettingsStore', () => {
    it('defaults to legacy when KV is empty', () => {
        expect(setup().store.saveMode()).toBe('legacy');
    });

    it('loads persisted saveMode', () => {
        expect(setup({ mas_save_mode: 'multi-agent' }).store.saveMode()).toBe('multi-agent');
        expect(setup({ mas_save_mode: 'legacy' }).store.saveMode()).toBe('legacy');
    });

    it('falls back to legacy on garbage values', () => {
        expect(setup({ mas_save_mode: 'something-else' }).store.saveMode()).toBe('legacy');
    });

    it('persists setSaveMode through KV', () => {
        const { store, kv } = setup();
        store.setSaveMode('multi-agent');
        expect(store.saveMode()).toBe('multi-agent');
        expect(kv.get('mas_save_mode')).toBe('multi-agent');
        store.setSaveMode('legacy');
        expect(kv.get('mas_save_mode')).toBe('legacy');
    });

    it('defaults subToolProfileId to "" (same-as-main) when KV is empty', () => {
        expect(setup().store.subToolProfileId()).toBe('');
    });

    it('loads + persists subToolProfileId through KV', () => {
        expect(setup({ mas_sub_tool_profile_id: 'local-small' }).store.subToolProfileId()).toBe('local-small');

        const { store, kv } = setup();
        store.setSubToolProfileId('cloud-gemini-2-flash');
        expect(store.subToolProfileId()).toBe('cloud-gemini-2-flash');
        expect(kv.get('mas_sub_tool_profile_id')).toBe('cloud-gemini-2-flash');

        // Empty string is a legal value (= "same as main"), distinct from
        // KV-absent. Verifies setter writes the empty string rather than
        // skipping the KV write.
        store.setSubToolProfileId('');
        expect(store.subToolProfileId()).toBe('');
        expect(kv.get('mas_sub_tool_profile_id')).toBe('');
    });
});
