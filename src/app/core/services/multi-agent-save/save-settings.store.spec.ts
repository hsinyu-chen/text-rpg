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
    it("defaults to '1-call' when KV is empty", () => {
        expect(setup().store.saveMode()).toBe('1-call');
    });

    it('loads persisted saveMode (current shape)', () => {
        expect(setup({ mas_save_mode: '1-call' }).store.saveMode()).toBe('1-call');
        expect(setup({ mas_save_mode: 'multi-call' }).store.saveMode()).toBe('multi-call');
    });

    it("migrates legacy 'legacy' KV value to '1-call'", () => {
        const { store, kv } = setup({ mas_save_mode: 'legacy' });
        expect(store.saveMode()).toBe('1-call');
        // Migration also writes the canonical value back so warm reads skip
        // the branch — guards a slow-drift cohort that never re-saved
        // settings after the rename.
        expect(kv.get('mas_save_mode')).toBe('1-call');
    });

    it("migrates legacy 'multi-agent' KV value to '1-call'", () => {
        const { store, kv } = setup({ mas_save_mode: 'multi-agent' });
        expect(store.saveMode()).toBe('1-call');
        expect(kv.get('mas_save_mode')).toBe('1-call');
    });

    it("falls back to '1-call' on garbage values", () => {
        expect(setup({ mas_save_mode: 'something-else' }).store.saveMode()).toBe('1-call');
    });

    it('persists setSaveMode through KV', () => {
        const { store, kv } = setup();
        store.setSaveMode('multi-call');
        expect(store.saveMode()).toBe('multi-call');
        expect(kv.get('mas_save_mode')).toBe('multi-call');
        store.setSaveMode('1-call');
        expect(kv.get('mas_save_mode')).toBe('1-call');
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

    it('defaults pauseBeforeAutoUpdate to false when KV is empty', () => {
        expect(setup().store.pauseBeforeAutoUpdate()).toBe(false);
    });

    it('loads pauseBeforeAutoUpdate from KV when persisted as "true"', () => {
        expect(setup({ mas_pause_before_auto_update: 'true' }).store.pauseBeforeAutoUpdate()).toBe(true);
    });

    it('treats any non-"true" value as off (defensive read)', () => {
        // The setter only ever writes 'true' or removes the key; anything else
        // is stale garbage from a hand-edited KV and should default off.
        expect(setup({ mas_pause_before_auto_update: 'yes' }).store.pauseBeforeAutoUpdate()).toBe(false);
        expect(setup({ mas_pause_before_auto_update: '' }).store.pauseBeforeAutoUpdate()).toBe(false);
    });

    it('persists setPauseBeforeAutoUpdate(true) and removes the key on (false)', () => {
        const { store, kv } = setup();
        store.setPauseBeforeAutoUpdate(true);
        expect(store.pauseBeforeAutoUpdate()).toBe(true);
        expect(kv.get('mas_pause_before_auto_update')).toBe('true');

        store.setPauseBeforeAutoUpdate(false);
        expect(store.pauseBeforeAutoUpdate()).toBe(false);
        // Absent ≡ off; matches the constructor's read semantics.
        expect(kv.get('mas_pause_before_auto_update')).toBeNull();
    });

    it('defaults hunkFixupProfileId to "" (fallback to main chat) when KV is empty', () => {
        expect(setup().store.hunkFixupProfileId()).toBe('');
    });

    it('loads + persists hunkFixupProfileId through KV', () => {
        expect(setup({ mas_hunk_fixup_profile_id: 'cloud-haiku' }).store.hunkFixupProfileId()).toBe('cloud-haiku');

        const { store, kv } = setup();
        store.setHunkFixupProfileId('local-small');
        expect(store.hunkFixupProfileId()).toBe('local-small');
        expect(kv.get('mas_hunk_fixup_profile_id')).toBe('local-small');

        // Empty string is a legal value (= "fallback to main"), distinct from
        // KV-absent. Same semantics as subToolProfileId.
        store.setHunkFixupProfileId('');
        expect(store.hunkFixupProfileId()).toBe('');
        expect(kv.get('mas_hunk_fixup_profile_id')).toBe('');
    });
});
