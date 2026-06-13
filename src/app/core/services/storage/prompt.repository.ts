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

    /**
     * Local hunk patches live in the same store under a `${type}:hunks` sub-key
     * (JSON array). Kept here so the profile-prefix range delete in
     * deleteAllForProfile sweeps them too — no separate table to clean up.
     */
    async getProfileHunks(type: string, profileId: string): Promise<unknown[]> {
        const row = await this.getProfilePrompt(`${type}:hunks`, profileId);
        if (!row?.content) return [];
        try {
            const parsed: unknown = JSON.parse(row.content);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    async saveProfileHunks(type: string, profileId: string, hunks: readonly unknown[]): Promise<void> {
        await this.saveProfilePrompt(`${type}:hunks`, profileId, JSON.stringify(hunks));
    }

    /**
     * Collect every type's non-empty hunk set for a profile, keyed by bare type.
     * Sync transports serialize this whole map as one unit (cloud `hunks` field /
     * disk `hunks.json`); empty types are omitted so the payload stays sparse.
     */
    async getAllProfileHunks(profileId: string, types: readonly string[]): Promise<Record<string, unknown[]>> {
        const entries = await Promise.all(
            types.map(async (type) => [type, await this.getProfileHunks(type, profileId)] as const),
        );
        const out: Record<string, unknown[]> = {};
        for (const [type, hunks] of entries) {
            if (hunks.length) out[type] = hunks;
        }
        return out;
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
