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
        // KV-absent. Verifies the setter writes the empty string rather than
        // skipping the KV write.
        store.setHunkFixupProfileId('');
        expect(store.hunkFixupProfileId()).toBe('');
        expect(kv.get('mas_hunk_fixup_profile_id')).toBe('');
    });

    it('defaults enabledSaveAgents to an empty set when KV is empty', () => {
        expect(setup().store.enabledSaveAgents().size).toBe(0);
    });

    it('loads enabledSaveAgents from a persisted JSON array', () => {
        const set = setup({ mas_enabled_save_agents: '["character","faction"]' }).store.enabledSaveAgents();
        expect([...set].sort()).toEqual(['character', 'faction']);
    });

    it('falls back to an empty set on a corrupt or non-array persisted value', () => {
        expect(setup({ mas_enabled_save_agents: 'not json' }).store.enabledSaveAgents().size).toBe(0);
        expect(setup({ mas_enabled_save_agents: '{"a":1}' }).store.enabledSaveAgents().size).toBe(0);
    });

    it('drops non-string elements from a persisted array (defensive read)', () => {
        const set = setup({ mas_enabled_save_agents: '["character",7,null]' }).store.enabledSaveAgents();
        expect([...set]).toEqual(['character']);
    });

    it('persists a non-empty set as JSON and removes the key when emptied', () => {
        const { store, kv } = setup();
        store.setEnabledSaveAgents(new Set(['character']));
        expect([...store.enabledSaveAgents()]).toEqual(['character']);
        expect(kv.get('mas_enabled_save_agents')).toBe('["character"]');

        // Empty ≡ no agents; absent key matches the constructor's read.
        store.setEnabledSaveAgents(new Set());
        expect(store.enabledSaveAgents().size).toBe(0);
        expect(kv.get('mas_enabled_save_agents')).toBeNull();
    });

    it('defaults saveAgentProfileIds to an empty object when KV is empty', () => {
        expect(setup().store.saveAgentProfileIds()).toEqual({});
    });

    it('loads saveAgentProfileIds from a persisted JSON object', () => {
        const map = setup({
            mas_save_agent_profile_ids: '{"character":"cloud-haiku","faction":"local-small"}',
        }).store.saveAgentProfileIds();
        expect(map).toEqual({ character: 'cloud-haiku', faction: 'local-small' });
    });

    it('falls back to an empty object on a corrupt, array, or null persisted value', () => {
        expect(setup({ mas_save_agent_profile_ids: 'not json' }).store.saveAgentProfileIds()).toEqual({});
        expect(setup({ mas_save_agent_profile_ids: '["a","b"]' }).store.saveAgentProfileIds()).toEqual({});
        expect(setup({ mas_save_agent_profile_ids: 'null' }).store.saveAgentProfileIds()).toEqual({});
    });

    it('drops non-string and empty-string values on read (defensive — "" ≡ main)', () => {
        const map = setup({
            mas_save_agent_profile_ids: '{"character":"cloud","faction":"","bogus":7}',
        }).store.saveAgentProfileIds();
        expect(map).toEqual({ character: 'cloud' });
    });

    it('persists a non-empty map, prunes "" entries, and removes the key when emptied', () => {
        const { store, kv } = setup();
        store.setSaveAgentProfileIds({ character: 'cloud-haiku', faction: '' });
        // '' is pruned — it means "same as main", identical to an absent entry.
        expect(store.saveAgentProfileIds()).toEqual({ character: 'cloud-haiku' });
        expect(kv.get('mas_save_agent_profile_ids')).toBe('{"character":"cloud-haiku"}');

        // All-empty ≡ no overrides; absent key matches the constructor's read.
        store.setSaveAgentProfileIds({ character: '' });
        expect(store.saveAgentProfileIds()).toEqual({});
        expect(kv.get('mas_save_agent_profile_ids')).toBeNull();
    });
});
