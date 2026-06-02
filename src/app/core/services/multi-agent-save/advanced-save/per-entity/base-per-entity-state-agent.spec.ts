import { describe, expect, it } from 'vitest';
import { shouldWarnProviderMismatch } from './base-per-entity-state-agent';

// The per-entity agent loop (provider check → seed → terminal dispatch →
// apply) is exercised by the dev-bridge smoke tests in the plan's "test
// evidence" table — mirroring InventoryConsistencyAgent, which has no loop
// unit test because mocking the full LLM stream is disproportionate. The one
// piece of pure agent logic, the aggregate-warning gate, is covered here.
describe('shouldWarnProviderMismatch', () => {
    it('does not warn below the minimum entity count, even at 100% non-entity', () => {
        expect(shouldWarnProviderMismatch(3, 3)).toBe(false);
        expect(shouldWarnProviderMismatch(1, 1)).toBe(false);
    });

    it('warns at the threshold (>=4 entities AND >=50% non-entity)', () => {
        expect(shouldWarnProviderMismatch(4, 2)).toBe(true);
        expect(shouldWarnProviderMismatch(10, 5)).toBe(true);
    });

    it('does not warn below the 50% ratio', () => {
        expect(shouldWarnProviderMismatch(4, 1)).toBe(false);
        expect(shouldWarnProviderMismatch(10, 4)).toBe(false);
    });

    it('does not warn on a clean run (zero non-entities)', () => {
        expect(shouldWarnProviderMismatch(8, 0)).toBe(false);
    });
});
