export function createParallelPool(concurrency: number) {
    return async function parallelPool<T>(
        items: T[],
        worker: (item: T, idx: number) => Promise<void>
    ): Promise<void> {
        if (items.length === 0) return;
        const workItems = items.map((item, index) => ({ item, index })).reverse();
        const runners = Array.from(
            { length: Math.min(concurrency, items.length) },
            async () => {
                while (workItems.length) {
                    const workItem = workItems.pop();
                    if (workItem === undefined) continue;
                    await worker(workItem.item, workItem.index);
                }
            }
        );
        await Promise.all(runners);
    }
}