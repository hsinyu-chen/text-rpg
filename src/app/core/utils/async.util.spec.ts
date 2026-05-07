import { describe, expect, it, vi } from 'vitest';
import { createParallelPool } from './async.util';

describe('createParallelPool', () => {
    it('no-op on empty array', async () => {
        const worker = vi.fn();
        await createParallelPool(4)([], worker);
        expect(worker).not.toHaveBeenCalled();
    });

    it('processes every item exactly once', async () => {
        const items = [10, 20, 30, 40, 50];
        const seen: number[] = [];
        await createParallelPool(2)(items, async v => { seen.push(v); });
        expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
    });

    it('forwards (item, index)', async () => {
        const calls: [string, number][] = [];
        await createParallelPool(2)(['a', 'b', 'c'], async (item, idx) => {
            calls.push([item, idx]);
        });
        expect(calls.sort()).toEqual([['a', 0], ['b', 1], ['c', 2]]);
    });

    it('caps concurrency below the worker count', async () => {
        let active = 0;
        let peak = 0;
        const release: Array<() => void> = [];
        const tasks = Array.from({ length: 6 }, () =>
            new Promise<void>(resolve => release.push(resolve))
        );

        const run = createParallelPool(2)(tasks, async t => {
            active++;
            peak = Math.max(peak, active);
            await t;
            active--;
        });

        // Drain in waves of 2 to confirm the cap holds.
        await Promise.resolve();
        await Promise.resolve();
        for (const r of release) r();
        await run;
        expect(peak).toBe(2);
    });

    it('handles falsy items (0, "", null) without skipping', async () => {
        const items: unknown[] = [0, '', null, false, undefined];
        const seen: unknown[] = [];
        await createParallelPool(2)(items, async v => { seen.push(v); });
        expect(seen).toHaveLength(items.length);
    });

    it('propagates worker rejection', async () => {
        const err = new Error('boom');
        await expect(
            createParallelPool(2)([1, 2, 3], async v => {
                if (v === 2) throw err;
            })
        ).rejects.toBe(err);
    });
});
