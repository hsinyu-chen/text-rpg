import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SyncReconciler } from './sync-reconciler.service';
import { ResourceAdapter, ResourceAdapterRegistry, SyncEntity } from './resource-adapter';
import { SyncTombstoneTracker } from './tombstone-tracker.service';
import { KVStore } from '../kv/kv-store';
import { InMemoryKVStore } from '../../testing/in-memory-kv-store';
import { RemoteEntry, SyncBackend, SyncDirection, SyncResource, Tombstone } from './sync.types';

interface RemoteRecord { json: string; lastActiveAt: number; }

/**
 * Skeleton backend exposing only the methods the reconciler exercises in the
 * two-way / pull-only / push-only paths. Tombstones live alongside the
 * objects but are queried via listTombstones() to mirror the real backend's
 * separate index.
 */
function makeBackend(): SyncBackend & { _objects: Record<SyncResource, Map<string, RemoteRecord>>; _tombs: Record<SyncResource, Map<string, Tombstone>>; } {
    const objects: Record<SyncResource, Map<string, RemoteRecord>> = {
        book: new Map(),
        collection: new Map(),
    };
    const tombs: Record<SyncResource, Map<string, Tombstone>> = {
        book: new Map(),
        collection: new Map(),
    };
    return {
        id: 's3',
        label: 'Test Backend',
        supportsBackgroundSync: true,
        authActionLabel: '',
        async initAsync() { /* no-op */ },
        isReady: () => true,
        configFingerprint: () => 'test',
        isAuthenticated: () => true,
        async authenticate() { /* no-op */ },
        async list(resource: SyncResource): Promise<RemoteEntry[]> {
            return [...objects[resource].entries()].map(([id, r]) => ({
                id,
                lastActiveAt: r.lastActiveAt,
                modifiedAt: r.lastActiveAt,
            }));
        },
        async read(resource: SyncResource, id: string): Promise<string> {
            const rec = objects[resource].get(id);
            if (!rec) throw new Error(`not found: ${resource}/${id}`);
            return rec.json;
        },
        async write(resource: SyncResource, id: string, json: string, lastActiveAt: number) {
            objects[resource].set(id, { json, lastActiveAt });
        },
        async remove(resource: SyncResource, id: string) {
            objects[resource].delete(id);
        },
        async listTombstones(resource: SyncResource): Promise<Tombstone[]> {
            return [...tombs[resource].values()];
        },
        async writeTombstone(resource: SyncResource, id: string, deletedAt: number) {
            tombs[resource].set(id, { id, deletedAt });
        },
        async clearTombstones(resource: SyncResource) {
            tombs[resource].clear();
        },
        readSettings: () => { throw new Error('unused'); },
        writeSettings: () => { throw new Error('unused'); },
        readPrompts: () => { throw new Error('unused'); },
        writePrompts: () => { throw new Error('unused'); },
        listSnapshots: () => { throw new Error('unused'); },
        readSnapshotManifest: () => { throw new Error('unused'); },
        createSnapshotFromCloud: () => { throw new Error('unused'); },
        createSnapshotFromLocal: () => { throw new Error('unused'); },
        restoreSnapshot: () => { throw new Error('unused'); },
        deleteSnapshot: () => { throw new Error('unused'); },
        updateSnapshotNote: () => { throw new Error('unused'); },
        _objects: objects,
        _tombs: tombs,
    };
}

interface FakeBook { id: string; lastActiveAt: number; name: string; }

/**
 * Adapter registry over plain in-memory Maps. Only `book` is exercised; the
 * `collection` adapter is wired to an empty map so the iteration order in
 * RESOURCES still drains without throwing.
 */
function makeAdapters(): ResourceAdapterRegistry & { _books: Map<string, FakeBook>; } {
    const books = new Map<string, FakeBook>();
    const empty = new Map<string, FakeBook>();
    const makeAdapter = (store: Map<string, FakeBook>): ResourceAdapter => ({
        list: async () => [...store.values()] as unknown as SyncEntity[],
        save: async (b) => { const fb = b as unknown as FakeBook; store.set(fb.id, fb); },
        delete: async (id) => { store.delete(id); },
        serialize: (b) => {
            const fb = b as unknown as FakeBook;
            return { json: JSON.stringify(fb), lastActiveAt: fb.lastActiveAt };
        },
        applyRemote: async (json) => {
            const fb = JSON.parse(json) as FakeBook;
            store.set(fb.id, fb);
            return fb as unknown as SyncEntity;
        },
        timestampOf: (b) => (b as unknown as FakeBook).lastActiveAt || 0,
    });
    const registry = {
        get: (r: SyncResource) => r === 'book' ? makeAdapter(books) : makeAdapter(empty),
        _books: books,
    } as unknown as ResourceAdapterRegistry & { _books: Map<string, FakeBook>; };
    return registry;
}

function setup(): {
    reconciler: SyncReconciler;
    backend: ReturnType<typeof makeBackend>;
    localBooks: Map<string, FakeBook>;
    tombstones: SyncTombstoneTracker;
} {
    const kv = new InMemoryKVStore();
    const adapters = makeAdapters();
    TestBed.configureTestingModule({
        providers: [
            { provide: KVStore, useValue: kv },
            { provide: ResourceAdapterRegistry, useValue: adapters },
        ],
    });
    return {
        reconciler: TestBed.inject(SyncReconciler),
        backend: makeBackend(),
        localBooks: adapters._books,
        tombstones: TestBed.inject(SyncTombstoneTracker),
    };
}

async function run(reconciler: SyncReconciler, backend: SyncBackend, direction: SyncDirection) {
    return reconciler.reconcileAll(backend, direction);
}

function seedLocal(localBooks: Map<string, FakeBook>, b: FakeBook) {
    localBooks.set(b.id, b);
}

function seedRemote(backend: ReturnType<typeof makeBackend>, b: FakeBook) {
    backend._objects.book.set(b.id, { json: JSON.stringify(b), lastActiveAt: b.lastActiveAt });
}

function seedTomb(backend: ReturnType<typeof makeBackend>, id: string, deletedAt: number) {
    backend._tombs.book.set(id, { id, deletedAt });
}

describe('SyncReconciler — direction matrix', () => {
    let ctx: ReturnType<typeof setup>;
    beforeEach(() => {
        TestBed.resetTestingModule();
        ctx = setup();
    });

    describe('two-way (legacy behaviour)', () => {
        it('uploads local-only entity', async () => {
            seedLocal(ctx.localBooks, { id: 'a', lastActiveAt: 100, name: 'A' });
            await run(ctx.reconciler, ctx.backend, 'two-way');
            expect(ctx.backend._objects.book.has('a')).toBe(true);
        });

        it('downloads remote-only entity', async () => {
            seedRemote(ctx.backend, { id: 'a', lastActiveAt: 100, name: 'A' });
            await run(ctx.reconciler, ctx.backend, 'two-way');
            expect(ctx.localBooks.has('a')).toBe(true);
        });

        it('propagates pending local delete (writes tombstone + removes remote)', async () => {
            seedRemote(ctx.backend, { id: 'a', lastActiveAt: 100, name: 'A' });
            // Local already removed; pending list carries the intent.
            ctx.tombstones.track('book', 'a');
            await run(ctx.reconciler, ctx.backend, 'two-way');
            expect(ctx.backend._objects.book.has('a')).toBe(false);
            expect(ctx.backend._tombs.book.has('a')).toBe(true);
            expect(ctx.tombstones.read('book')).toHaveLength(0);
        });

        it('consumes cloud tombstone — deletes local + remote orphan', async () => {
            seedLocal(ctx.localBooks, { id: 'a', lastActiveAt: 100, name: 'A' });
            seedRemote(ctx.backend, { id: 'a', lastActiveAt: 100, name: 'A' });
            seedTomb(ctx.backend, 'a', 200);
            await run(ctx.reconciler, ctx.backend, 'two-way');
            expect(ctx.localBooks.has('a')).toBe(false);
            expect(ctx.backend._objects.book.has('a')).toBe(false);
        });
    });

    describe('pull-only', () => {
        it('downloads remote-only entity', async () => {
            seedRemote(ctx.backend, { id: 'a', lastActiveAt: 100, name: 'A' });
            await run(ctx.reconciler, ctx.backend, 'pull-only');
            expect(ctx.localBooks.has('a')).toBe(true);
        });

        it('does NOT upload local-only entity (cloud may have just deleted it)', async () => {
            seedLocal(ctx.localBooks, { id: 'a', lastActiveAt: 100, name: 'A' });
            await run(ctx.reconciler, ctx.backend, 'pull-only');
            expect(ctx.backend._objects.book.has('a')).toBe(false);
        });

        it('drops pending local-delete queue without propagating', async () => {
            seedRemote(ctx.backend, { id: 'a', lastActiveAt: 100, name: 'A' });
            // User deleted locally then mode flipped before the next sync.
            ctx.tombstones.track('book', 'a');
            // Local was already removed at delete time; cloud still has the book.
            await run(ctx.reconciler, ctx.backend, 'pull-only');
            // Cloud untouched + tomb not written.
            expect(ctx.backend._objects.book.has('a')).toBe(true);
            expect(ctx.backend._tombs.book.has('a')).toBe(false);
            // Pending dropped: next two-way run won't accidentally re-delete cloud.
            expect(ctx.tombstones.read('book')).toHaveLength(0);
            // Read book resurrected into local — pull-only is a mirror.
            expect(ctx.localBooks.has('a')).toBe(true);
        });

        it('consumes cloud tombstone — deletes local, leaves cloud orphan alone', async () => {
            seedLocal(ctx.localBooks, { id: 'a', lastActiveAt: 100, name: 'A' });
            // Edge: cloud tombstone exists AND cloud object still exists
            // (orphan from a prior failed remove). Pull-only must not write
            // to cloud, so the orphan stays.
            seedRemote(ctx.backend, { id: 'a', lastActiveAt: 100, name: 'A' });
            seedTomb(ctx.backend, 'a', 200);
            await run(ctx.reconciler, ctx.backend, 'pull-only');
            expect(ctx.localBooks.has('a')).toBe(false);
            expect(ctx.backend._objects.book.has('a')).toBe(true); // orphan untouched
        });

        it('keeps local that is newer than cloud tombstone (post-delete edit) and does NOT upload', async () => {
            // Tomb says "deleted at 100" but local was edited at 200 — LWW
            // says local survives. Under pull-only the survivor must NOT
            // propagate back to cloud (canUpload=false), so cloud stays
            // unchanged.
            seedLocal(ctx.localBooks, { id: 'a', lastActiveAt: 200, name: 'A-edited' });
            seedTomb(ctx.backend, 'a', 100);
            await run(ctx.reconciler, ctx.backend, 'pull-only');
            expect(ctx.localBooks.get('a')?.name).toBe('A-edited');
            expect(ctx.backend._objects.book.has('a')).toBe(false);
        });
    });

    describe('push-only', () => {
        it('uploads local-only entity', async () => {
            seedLocal(ctx.localBooks, { id: 'a', lastActiveAt: 100, name: 'A' });
            await run(ctx.reconciler, ctx.backend, 'push-only');
            expect(ctx.backend._objects.book.has('a')).toBe(true);
        });

        it('does NOT delete cloud orphan (may belong to another device)', async () => {
            seedRemote(ctx.backend, { id: 'a', lastActiveAt: 100, name: 'A' });
            await run(ctx.reconciler, ctx.backend, 'push-only');
            expect(ctx.backend._objects.book.has('a')).toBe(true);
            expect(ctx.localBooks.has('a')).toBe(false); // not downloaded either
        });

        it('ignores cloud tombstone — local untouched', async () => {
            seedLocal(ctx.localBooks, { id: 'a', lastActiveAt: 100, name: 'A' });
            seedTomb(ctx.backend, 'a', 200);
            await run(ctx.reconciler, ctx.backend, 'push-only');
            expect(ctx.localBooks.has('a')).toBe(true);
            // local-only path then re-uploads it — push-only treats local as truth.
            expect(ctx.backend._objects.book.has('a')).toBe(true);
        });

        it('propagates pending local delete (same as two-way)', async () => {
            seedRemote(ctx.backend, { id: 'a', lastActiveAt: 100, name: 'A' });
            ctx.tombstones.track('book', 'a');
            await run(ctx.reconciler, ctx.backend, 'push-only');
            expect(ctx.backend._objects.book.has('a')).toBe(false);
            expect(ctx.backend._tombs.book.has('a')).toBe(true);
            expect(ctx.tombstones.read('book')).toHaveLength(0);
        });

        it('does NOT download remote-newer entity', async () => {
            seedLocal(ctx.localBooks, { id: 'a', lastActiveAt: 100, name: 'A-old' });
            seedRemote(ctx.backend, { id: 'a', lastActiveAt: 200, name: 'A-new' });
            await run(ctx.reconciler, ctx.backend, 'push-only');
            expect(ctx.localBooks.get('a')?.name).toBe('A-old');
        });
    });
});
