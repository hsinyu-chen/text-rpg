import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ActiveProfileStore } from './active-profile-store';
import { KVStore } from './kv/kv-store';
import { InMemoryKVStore } from '../testing/in-memory-kv-store';
import { DEFAULT_PROFILE_ID } from '../constants/prompt-profiles';

function setup(seed: Record<string, string> = {}): { store: ActiveProfileStore; kv: InMemoryKVStore } {
    const kv = new InMemoryKVStore(seed);
    TestBed.configureTestingModule({
        providers: [{ provide: KVStore, useValue: kv }],
    });
    return { store: TestBed.inject(ActiveProfileStore), kv };
}

describe('ActiveProfileStore', () => {
    it('falls back to DEFAULT_PROFILE_ID when nothing is persisted', () => {
        const { store } = setup();
        expect(store.id()).toBe(DEFAULT_PROFILE_ID);
    });

    it('loads the persisted profile id on construction', () => {
        const { store } = setup({ app_active_prompt_profile: 'custom-123' });
        expect(store.id()).toBe('custom-123');
    });

    it('set() updates the signal and persists in lock-step', () => {
        const { store, kv } = setup();
        store.set('local');
        expect(store.id()).toBe('local');
        expect(kv.get('app_active_prompt_profile')).toBe('local');
    });
});
