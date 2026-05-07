import { Injectable, inject } from '@angular/core';
import { IdbBootstrap } from './idb-bootstrap.service';
import { DEFAULT_PROFILE_ID } from '../../constants/prompt-profiles';

interface PromptRow { content: string; lastModified: number; tokens?: number }

/**
 * prompt_store keys are profile-scoped: `${profileId}:${name}` for user
 * profiles, bare `${name}` for the default profile (preserved for backward
 * compatibility with v5-era data).
 *
 * Range delete on a profile prefix uses an explicit transaction because
 * IdbStore doesn't expose IDBKeyRange operations.
 */
@Injectable({ providedIn: 'root' })
export class PromptRepository {
    private dbPromise = inject(IdbBootstrap).db;

    private buildKey(name: string, profileId: string): string {
        return profileId === DEFAULT_PROFILE_ID ? name : `${profileId}:${name}`;
    }

    async getProfilePrompt(name: string, profileId: string): Promise<PromptRow | undefined> {
        const db = await this.dbPromise;
        return db.get('prompt_store', this.buildKey(name, profileId));
    }

    async saveProfilePrompt(name: string, profileId: string, content: string, tokens?: number): Promise<void> {
        const db = await this.dbPromise;
        const key = this.buildKey(name, profileId);
        await db.put('prompt_store', { content, tokens, lastModified: Date.now() }, key);
    }

    /** No-op for the default profile — its rows are unprefixed and would all be wiped. */
    async deleteAllForProfile(profileId: string): Promise<void> {
        if (profileId === DEFAULT_PROFILE_ID) return;
        const db = await this.dbPromise;
        const tx = db.transaction('prompt_store', 'readwrite');
        const prefix = `${profileId}:`;
        await tx.store.delete(IDBKeyRange.bound(prefix, prefix + '￿'));
        await tx.done;
    }
}
