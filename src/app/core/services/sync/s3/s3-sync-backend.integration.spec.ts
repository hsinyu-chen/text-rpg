/**
 * Integration spec for {@link S3SyncBackend} against a real S3-compatible
 * endpoint (default target: SeaweedFS at `s3.dynameis.app`).
 *
 * **Skipped** unless every `S3_TEST_*` env var below is set — typically via
 * `.env.test.local` (gitignored), but shell env works too:
 *   - `S3_TEST_ENDPOINT`
 *   - `S3_TEST_REGION`
 *   - `S3_TEST_BUCKET`
 *   - `S3_TEST_ACCESS_KEY_ID`
 *   - `S3_TEST_SECRET_ACCESS_KEY`
 *   - `S3_TEST_FORCE_PATH_STYLE` (optional, defaults to true)
 *
 * Each test uses a unique prefix (`spec-<uuid>`) inside the configured
 * bucket, and `afterEach` wipes everything under that prefix. Bucket itself
 * is NOT created or deleted by the tests.
 *
 * Purpose: lock down S3SyncBackend's externally-observable behaviour so the
 * upcoming BlobStore + Repositories refactor (PR2 in
 * `sync-architecture-cleanup.md`) can be verified against the same suite.
 */
import { describe, beforeAll, beforeEach, afterEach, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3SyncBackend } from './s3-sync-backend';
import { S3ConfigService } from './s3-config.service';
import { KVStore } from '../../kv/kv-store';
import { InMemoryKVStore } from '../../../testing/in-memory-kv-store';
import { S3Config, SyncResource, SnapshotLocalPayload } from '../sync.types';

const REQUIRED_ENV = [
    'S3_TEST_ENDPOINT', 'S3_TEST_REGION', 'S3_TEST_BUCKET',
    'S3_TEST_ACCESS_KEY_ID', 'S3_TEST_SECRET_ACCESS_KEY'
] as const;
const HAVE_CREDS = REQUIRED_ENV.every(k => !!process.env[k]);

type AwsSdk = typeof import('@aws-sdk/client-s3');

function makeBaseConfig(prefix: string): S3Config {
    return {
        endpoint: process.env['S3_TEST_ENDPOINT']!,
        region: process.env['S3_TEST_REGION']!,
        bucket: process.env['S3_TEST_BUCKET']!,
        accessKeyId: process.env['S3_TEST_ACCESS_KEY_ID']!,
        secretAccessKey: process.env['S3_TEST_SECRET_ACCESS_KEY']!,
        prefix,
        forcePathStyle: process.env['S3_TEST_FORCE_PATH_STYLE'] !== 'false'
    };
}

function uniquePrefix(): string {
    return `spec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function wipePrefix(client: S3Client, sdk: AwsSdk, bucket: string, prefix: string): Promise<void> {
    const dirPrefix = prefix.replace(/^\/+|\/+$/g, '') + '/';
    let continuationToken: string | undefined;
    do {
        const res = await client.send(new sdk.ListObjectsV2Command({
            Bucket: bucket, Prefix: dirPrefix, ContinuationToken: continuationToken
        }));
        for (const obj of res.Contents ?? []) {
            if (!obj.Key) continue;
            await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
}

/** Lists every key under `dirPrefix` (no `<prefix>/` suffix added). */
async function listAllKeys(
    client: S3Client, sdk: AwsSdk, bucket: string, dirPrefix: string
): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
        const res = await client.send(new sdk.ListObjectsV2Command({
            Bucket: bucket, Prefix: dirPrefix, ContinuationToken: continuationToken
        }));
        for (const obj of res.Contents ?? []) {
            if (obj.Key) keys.push(obj.Key);
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys.sort();
}

interface ObjectShape {
    body: string;
    metadata: Record<string, string>;
    contentType?: string;
}

async function inspectObject(
    client: S3Client, sdk: AwsSdk, bucket: string, key: string
): Promise<ObjectShape> {
    const res = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body ? await res.Body.transformToString() : '';
    return {
        body,
        metadata: res.Metadata ?? {},
        contentType: res.ContentType
    };
}

// Sample bodies sized realistically (~book ≈ small, but enough to be a
// nontrivial body). lastActiveAt embedded in body too — exercises the
// metadata-stripped fallback path in hydrateRemoteEntry.
function makeBookJson(id: string, lastActiveAt: number, title = `book-${id}`): string {
    return JSON.stringify({ id, title, lastActiveAt, content: 'sample content' });
}

function makeCollectionJson(id: string, updatedAt: number, name = `coll-${id}`): string {
    return JSON.stringify({ id, name, updatedAt, members: [] });
}

// Fixed (and `assertSnapshotId`-valid) id used by every snapshot-touching
// test. Each test runs under its own bucket prefix so collisions across
// tests aren't a concern; reusing the same id keeps assertions readable.
const SAMPLE_SNAPSHOT_ID = '20260508T010203-abcd1234';

describe.skipIf(!HAVE_CREDS)('S3SyncBackend integration', () => {
    let backend: S3SyncBackend;
    let cfgSvc: S3ConfigService;
    let prefix: string;
    let sdk: AwsSdk;
    let cleanupClient: S3Client;

    beforeAll(async () => {
        // One throwaway client just for afterEach cleanup. Lives across all
        // tests; never touched by the backend under test.
        sdk = await import('@aws-sdk/client-s3');
        const baseCfg = makeBaseConfig('');
        cleanupClient = new sdk.S3Client({
            endpoint: baseCfg.endpoint,
            region: baseCfg.region,
            credentials: {
                accessKeyId: baseCfg.accessKeyId,
                secretAccessKey: baseCfg.secretAccessKey
            },
            forcePathStyle: baseCfg.forcePathStyle ?? true
        });
    });

    beforeEach(async () => {
        prefix = uniquePrefix();
        const kv = new InMemoryKVStore();
        TestBed.configureTestingModule({
            providers: [
                S3SyncBackend,
                S3ConfigService,
                { provide: KVStore, useValue: kv }
            ]
        });
        cfgSvc = TestBed.inject(S3ConfigService);
        cfgSvc.save(makeBaseConfig(prefix));
        backend = TestBed.inject(S3SyncBackend);
        await backend.initAsync();
    });

    afterEach(async () => {
        // Keep cleanup per-prefix so a failing test doesn't pollute the next run.
        await wipePrefix(cleanupClient, sdk, process.env['S3_TEST_BUCKET']!, prefix);
    });

    // ===== entries: list / read / write / remove =========================

    describe('entries', () => {
        it('list returns empty array for empty resource', async () => {
            await expect(backend.list('book')).resolves.toEqual([]);
            await expect(backend.list('collection')).resolves.toEqual([]);
        });

        it('write + list round-trips lastActiveAt via metadata', async () => {
            const ts = 1_700_000_000_000;
            await backend.write('book', 'book-A', makeBookJson('book-A', ts), ts);

            const entries = await backend.list('book');
            expect(entries).toHaveLength(1);
            expect(entries[0].id).toBe('book-A');
            expect(entries[0].lastActiveAt).toBe(ts);
        });

        it('read returns the body verbatim', async () => {
            const body = makeBookJson('book-X', 1_700_000_001_000);
            await backend.write('book', 'book-X', body, 1_700_000_001_000);

            await expect(backend.read('book', 'book-X')).resolves.toBe(body);
        });

        it('remove drops the entry from list', async () => {
            await backend.write('collection', 'col-1', makeCollectionJson('col-1', 1_700_000_002_000), 1_700_000_002_000);
            await backend.remove('collection', 'col-1');

            await expect(backend.list('collection')).resolves.toEqual([]);
        });

        it('list scopes to the configured prefix', async () => {
            await backend.write('book', 'in-scope', makeBookJson('in-scope', 1), 1);

            // Write something at a different prefix via the cleanup client —
            // it must NOT show up in our backend's list().
            const otherPrefix = uniquePrefix();
            try {
                await cleanupClient.send(new sdk.PutObjectCommand({
                    Bucket: process.env['S3_TEST_BUCKET']!,
                    Key: `${otherPrefix}/books/out-of-scope.json`,
                    Body: '{}',
                    ContentType: 'application/json'
                }));
                const entries = await backend.list('book');
                expect(entries.map(e => e.id)).toEqual(['in-scope']);
            } finally {
                await wipePrefix(cleanupClient, sdk, process.env['S3_TEST_BUCKET']!, otherPrefix);
            }
        });

        it('list books and collections are isolated from each other', async () => {
            await backend.write('book', 'b1', makeBookJson('b1', 1), 1);
            await backend.write('collection', 'c1', makeCollectionJson('c1', 2), 2);

            const books = await backend.list('book');
            const colls = await backend.list('collection');
            expect(books.map(e => e.id)).toEqual(['b1']);
            expect(colls.map(e => e.id)).toEqual(['c1']);
        });
    });

    // ===== tombstones =====================================================

    describe('tombstones', () => {
        it('listTombstones returns empty for empty resource', async () => {
            await expect(backend.listTombstones('book')).resolves.toEqual([]);
            await expect(backend.listTombstones('collection')).resolves.toEqual([]);
        });

        it('writeTombstone + listTombstones round-trips deletedAt', async () => {
            await backend.writeTombstone('book', 'book-T', 1_700_000_010_000);

            const tombs = await backend.listTombstones('book');
            expect(tombs).toEqual([{ id: 'book-T', deletedAt: 1_700_000_010_000 }]);
        });

        it('multiple deletedAt values for same id → max wins', async () => {
            const id = 'book-multi';
            await backend.writeTombstone('book', id, 100);
            await backend.writeTombstone('book', id, 300);
            await backend.writeTombstone('book', id, 200);

            const tombs = await backend.listTombstones('book');
            expect(tombs).toEqual([{ id, deletedAt: 300 }]);
        });

        it('listTombstones returns multiple ids correctly', async () => {
            await backend.writeTombstone('collection', 'c-a', 10);
            await backend.writeTombstone('collection', 'c-b', 20);
            await backend.writeTombstone('collection', 'c-c', 30);

            const tombs = await backend.listTombstones('collection');
            const sorted = tombs.slice().sort((x, y) => x.deletedAt - y.deletedAt);
            expect(sorted).toEqual([
                { id: 'c-a', deletedAt: 10 },
                { id: 'c-b', deletedAt: 20 },
                { id: 'c-c', deletedAt: 30 }
            ]);
        });

        it('clearTombstones empties the tombstone tree', async () => {
            await backend.writeTombstone('book', 'b1', 100);
            await backend.writeTombstone('book', 'b2', 200);

            await backend.clearTombstones('book');

            await expect(backend.listTombstones('book')).resolves.toEqual([]);
        });

        it('book and collection tombstones are isolated', async () => {
            await backend.writeTombstone('book', 'b1', 100);
            await backend.writeTombstone('collection', 'c1', 200);

            await expect(backend.listTombstones('book')).resolves.toEqual([{ id: 'b1', deletedAt: 100 }]);
            await expect(backend.listTombstones('collection')).resolves.toEqual([{ id: 'c1', deletedAt: 200 }]);
        });
    });

    // ===== settings / prompts =============================================

    describe('settings / prompts', () => {
        it('readSettings returns null when not yet written', async () => {
            await expect(backend.readSettings()).resolves.toBeNull();
        });

        it('writeSettings + readSettings round-trips', async () => {
            const content = JSON.stringify({ theme: 'dark', autoSync: true });
            await backend.writeSettings(content);
            await expect(backend.readSettings()).resolves.toBe(content);
        });

        it('readPrompts returns null when not yet written', async () => {
            await expect(backend.readPrompts()).resolves.toBeNull();
        });

        it('writePrompts + readPrompts round-trips', async () => {
            const content = JSON.stringify({ profiles: [{ id: 'p1', system: 'be helpful' }] });
            await backend.writePrompts(content);
            await expect(backend.readPrompts()).resolves.toBe(content);
        });
    });

    // ===== snapshots ======================================================

    describe('snapshots', () => {
        it('listSnapshots returns empty initially', async () => {
            await expect(backend.listSnapshots()).resolves.toEqual([]);
        });

        it('createSnapshotFromCloud captures live entries + tombstones', async () => {
            // Seed live state.
            await backend.write('book', 'b1', makeBookJson('b1', 1000), 1000);
            await backend.write('book', 'b2', makeBookJson('b2', 2000), 2000);
            await backend.write('collection', 'c1', makeCollectionJson('c1', 3000), 3000);
            await backend.writeTombstone('book', 'gone-1', 4000);

            const manifest = await backend.createSnapshotFromCloud(SAMPLE_SNAPSHOT_ID, {
                createdAt: 5000, trigger: 'manual', note: 'first'
            });

            expect(manifest.id).toBe(SAMPLE_SNAPSHOT_ID);
            expect(manifest.bookCount).toBe(2);
            expect(manifest.collectionCount).toBe(1);
            expect(manifest.tombstoneCount).toBe(1);
            expect(manifest.entries.book.map(e => e.id).sort()).toEqual(['b1', 'b2']);
            expect(manifest.entries.collection.map(e => e.id)).toEqual(['c1']);
            expect(manifest.entries.tombstone).toEqual([{ resource: 'book', id: 'gone-1', deletedAt: 4000 }]);

            // listSnapshots reflects it.
            const list = await backend.listSnapshots();
            expect(list).toHaveLength(1);
            expect(list[0].id).toBe(SAMPLE_SNAPSHOT_ID);
            expect(list[0].note).toBe('first');
        });

        it('createSnapshotFromCloud applies "book wins" tombstone dedupe', async () => {
            // Same id appears as both live book AND tombstone — book wins,
            // tombstone should NOT be in the manifest.
            await backend.write('book', 'shared-id', makeBookJson('shared-id', 1000), 1000);
            await backend.writeTombstone('book', 'shared-id', 2000);

            const manifest = await backend.createSnapshotFromCloud(SAMPLE_SNAPSHOT_ID, {
                createdAt: 3000, trigger: 'manual'
            });
            expect(manifest.entries.book.map(e => e.id)).toEqual(['shared-id']);
            expect(manifest.entries.tombstone).toEqual([]);
        });

        it('createSnapshotFromLocal uses caller-supplied bodies', async () => {
            const payload: SnapshotLocalPayload = {
                books: [
                    { id: 'lb1', lastActiveAt: 100, json: makeBookJson('lb1', 100) },
                    { id: 'lb2', lastActiveAt: 200, json: makeBookJson('lb2', 200) }
                ],
                collections: [
                    { id: 'lc1', lastActiveAt: 300, json: makeCollectionJson('lc1', 300) }
                ],
                tombstones: [
                    { resource: 'book' as SyncResource, id: 'lgone', deletedAt: 400 }
                ]
            };
            const manifest = await backend.createSnapshotFromLocal(SAMPLE_SNAPSHOT_ID, {
                createdAt: 500, trigger: 'forcePull'
            }, payload);

            expect(manifest.bookCount).toBe(2);
            expect(manifest.collectionCount).toBe(1);
            expect(manifest.tombstoneCount).toBe(1);
            expect(manifest.entries.book.map(e => e.id).sort()).toEqual(['lb1', 'lb2']);
            expect(manifest.entries.tombstone).toEqual([{ resource: 'book', id: 'lgone', deletedAt: 400 }]);
        });

        it('readSnapshotManifest matches createSnapshot return', async () => {
            await backend.write('book', 'b1', makeBookJson('b1', 1000), 1000);
            const created = await backend.createSnapshotFromCloud(SAMPLE_SNAPSHOT_ID, {
                createdAt: 2000, trigger: 'manual'
            });
            const read = await backend.readSnapshotManifest(SAMPLE_SNAPSHOT_ID);
            expect(read).toEqual(created);
        });

        it('updateSnapshotNote rewrites manifest note', async () => {
            await backend.createSnapshotFromCloud(SAMPLE_SNAPSHOT_ID, {
                createdAt: 1000, trigger: 'manual', note: 'before'
            });
            await backend.updateSnapshotNote(SAMPLE_SNAPSHOT_ID, 'after');

            const read = await backend.readSnapshotManifest(SAMPLE_SNAPSHOT_ID);
            expect(read.note).toBe('after');

            const list = await backend.listSnapshots();
            expect(list[0].note).toBe('after');
        });

        it('restoreSnapshot restamps lastActiveAt and writes manifest content to live', async () => {
            // Seed snapshot via from-local (bypasses live state requirement).
            const originalLastActive = 1_700_000_000_000;
            const payload: SnapshotLocalPayload = {
                books: [{ id: 'rb1', lastActiveAt: originalLastActive, json: makeBookJson('rb1', originalLastActive) }],
                collections: [],
                tombstones: []
            };
            await backend.createSnapshotFromLocal(SAMPLE_SNAPSHOT_ID, {
                createdAt: 1, trigger: 'forcePull'
            }, payload);

            const before = Date.now();
            await backend.restoreSnapshot(SAMPLE_SNAPSHOT_ID);
            const after = Date.now();

            // The restored entry exists in live with restamped lastActiveAt.
            const live = await backend.list('book');
            expect(live).toHaveLength(1);
            expect(live[0].id).toBe('rb1');
            expect(live[0].lastActiveAt).toBeGreaterThanOrEqual(before);
            expect(live[0].lastActiveAt).toBeLessThanOrEqual(after);
            expect(live[0].lastActiveAt).not.toBe(originalLastActive);
        });

        it('restoreSnapshot diff-deletes live entries not in manifest', async () => {
            // Snapshot only has b1; live has b1 + b2 → b2 must go.
            await backend.write('book', 'b1', makeBookJson('b1', 1000), 1000);
            await backend.createSnapshotFromCloud(SAMPLE_SNAPSHOT_ID, {
                createdAt: 2000, trigger: 'manual'
            });
            await backend.write('book', 'b2', makeBookJson('b2', 3000), 3000);

            await backend.restoreSnapshot(SAMPLE_SNAPSHOT_ID);

            const live = await backend.list('book');
            expect(live.map(e => e.id)).toEqual(['b1']);
        });

        it('restoreSnapshot rewrites tombstones with new deletedAt', async () => {
            await backend.writeTombstone('book', 'tb1', 1000);
            await backend.createSnapshotFromCloud(SAMPLE_SNAPSHOT_ID, {
                createdAt: 2000, trigger: 'manual'
            });
            // Mutate live tombstones between snapshot and restore.
            await backend.writeTombstone('book', 'tb1', 5000); // newer
            await backend.writeTombstone('book', 'tb-extra', 6000);

            const before = Date.now();
            await backend.restoreSnapshot(SAMPLE_SNAPSHOT_ID);
            const after = Date.now();

            const tombs = await backend.listTombstones('book');
            // After restore, only tb1 (in manifest) remains, with restamped deletedAt.
            expect(tombs).toHaveLength(1);
            expect(tombs[0].id).toBe('tb1');
            expect(tombs[0].deletedAt).toBeGreaterThanOrEqual(before);
            expect(tombs[0].deletedAt).toBeLessThanOrEqual(after);
        });

        it('deleteSnapshot removes the entire snapshot tree', async () => {
            await backend.write('book', 'b1', makeBookJson('b1', 1), 1);
            await backend.createSnapshotFromCloud(SAMPLE_SNAPSHOT_ID, { createdAt: 2, trigger: 'manual' });

            await backend.deleteSnapshot(SAMPLE_SNAPSHOT_ID);

            await expect(backend.listSnapshots()).resolves.toEqual([]);
            await expect(backend.readSnapshotManifest(SAMPLE_SNAPSHOT_ID)).rejects.toThrow();
        });
    });

    // ===== on-disk shape ===================================================
    //
    // Inspect raw S3 keys + bodies + user-metadata via a separate (cleanup)
    // client. PR2's BlobStore + Repositories refactor must keep these
    // unchanged — same keys, same metadata names, same body bytes — otherwise
    // a device on the new code can't read what a device on the old code wrote
    // (or vice versa) since they share the same cloud storage.

    describe('on-disk shape', () => {
        const fullKey = (sub: string) => `${prefix}/${sub}`;

        it('write book → key=<prefix>/books/<id>.json with metadata last-active', async () => {
            const ts = 1_700_000_111_000;
            const body = makeBookJson('shape-b1', ts);
            await backend.write('book', 'shape-b1', body, ts);

            const obj = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey('books/shape-b1.json')
            );
            expect(obj.body).toBe(body);
            expect(obj.metadata['last-active']).toBe(String(ts));
            expect(obj.contentType).toBe('application/json');
        });

        it('write collection → key=<prefix>/collections/<id>.json with metadata last-active', async () => {
            const ts = 1_700_000_222_000;
            const body = makeCollectionJson('shape-c1', ts);
            await backend.write('collection', 'shape-c1', body, ts);

            const obj = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey('collections/shape-c1.json')
            );
            expect(obj.body).toBe(body);
            expect(obj.metadata['last-active']).toBe(String(ts));
            expect(obj.contentType).toBe('application/json');
        });

        it('writeTombstone → key=<prefix>/tombstones/<resource-dir>/<id>/<deletedAt>, empty body', async () => {
            await backend.writeTombstone('book', 'shape-tb1', 1_700_000_333_000);
            await backend.writeTombstone('collection', 'shape-tc1', 1_700_000_444_000);

            const allKeys = await listAllKeys(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!, `${prefix}/tombstones/`
            );
            expect(allKeys).toEqual([
                fullKey('tombstones/books/shape-tb1/1700000333000'),
                fullKey('tombstones/collections/shape-tc1/1700000444000')
            ]);

            const tombObj = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey('tombstones/books/shape-tb1/1700000333000')
            );
            expect(tombObj.body).toBe('');
        });

        it('writeSettings → key=<prefix>/settings.json (application/json)', async () => {
            const content = JSON.stringify({ a: 1 });
            await backend.writeSettings(content);

            const obj = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey('settings.json')
            );
            expect(obj.body).toBe(content);
            expect(obj.contentType).toBe('application/json');
        });

        it('writePrompts → key=<prefix>/prompts.json (application/json)', async () => {
            const content = JSON.stringify({ profiles: [] });
            await backend.writePrompts(content);

            const obj = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey('prompts.json')
            );
            expect(obj.body).toBe(content);
            expect(obj.contentType).toBe('application/json');
        });

        it('createSnapshotFromCloud → snapshot tree under <prefix>/snapshots/<sid>/', async () => {
            await backend.write('book', 'sb1', makeBookJson('sb1', 1000), 1000);
            await backend.write('collection', 'sc1', makeCollectionJson('sc1', 2000), 2000);
            await backend.writeTombstone('book', 'sgone', 3000);

            await backend.createSnapshotFromCloud(SAMPLE_SNAPSHOT_ID, {
                createdAt: 4000, trigger: 'manual', note: 'shape-test'
            });

            const snapKeys = await listAllKeys(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!, `${prefix}/snapshots/${SAMPLE_SNAPSHOT_ID}/`
            );
            // Note: ordering matches sort by string. Manifest is at the top
            // of the snapshot folder; entries follow.
            expect(snapKeys).toEqual([
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/books/sb1.json`),
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/collections/sc1.json`),
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/manifest.json`),
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/tombstones/books/sgone/3000`)
            ]);

            // Snapshot copies MUST preserve original last-active metadata
            // (CopyObject MetadataDirective: 'COPY'). This is the
            // load-bearing invariant for "snapshot is a true historical
            // artefact" — restore re-stamps to now, but the snapshot
            // itself keeps the original timestamps.
            const sb1Snap = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/books/sb1.json`)
            );
            expect(sb1Snap.metadata['last-active']).toBe('1000');

            const sc1Snap = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/collections/sc1.json`)
            );
            expect(sc1Snap.metadata['last-active']).toBe('2000');

            // Manifest body shape: parses to JSON with the right top-level
            // fields. We don't lock down EVERY field (entries arrive in
            // completion order from parallelPool then sorted, so the order
            // is stable but the field set may evolve), just the load-
            // bearing ones.
            const manifestObj = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/manifest.json`)
            );
            const manifest = JSON.parse(manifestObj.body);
            expect(manifest.id).toBe(SAMPLE_SNAPSHOT_ID);
            expect(manifest.version).toBe(1);
            expect(manifest.bookCount).toBe(1);
            expect(manifest.collectionCount).toBe(1);
            expect(manifest.tombstoneCount).toBe(1);
            expect(manifest.note).toBe('shape-test');
            expect(manifestObj.contentType).toBe('application/json');
        });

        it('createSnapshotFromLocal → entry bodies + last-active match payload exactly', async () => {
            const payload: SnapshotLocalPayload = {
                books: [{ id: 'plb1', lastActiveAt: 1234, json: makeBookJson('plb1', 1234) }],
                collections: [{ id: 'plc1', lastActiveAt: 5678, json: makeCollectionJson('plc1', 5678) }],
                tombstones: [{ resource: 'book' as SyncResource, id: 'pgone', deletedAt: 9999 }]
            };
            await backend.createSnapshotFromLocal(SAMPLE_SNAPSHOT_ID, {
                createdAt: 1, trigger: 'forcePull'
            }, payload);

            const bookSnap = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/books/plb1.json`)
            );
            expect(bookSnap.body).toBe(payload.books[0].json);
            expect(bookSnap.metadata['last-active']).toBe('1234');

            const collSnap = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/collections/plc1.json`)
            );
            expect(collSnap.body).toBe(payload.collections[0].json);
            expect(collSnap.metadata['last-active']).toBe('5678');

            // Tombstone path includes deletedAt verbatim.
            const tombKeys = await listAllKeys(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                `${prefix}/snapshots/${SAMPLE_SNAPSHOT_ID}/tombstones/`
            );
            expect(tombKeys).toEqual([
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/tombstones/books/pgone/9999`)
            ]);
        });

        it('restoreSnapshot → live entries get metadata last-active = now (NOT snapshot value)', async () => {
            const originalTs = 1_000_000_000;
            await backend.createSnapshotFromLocal(SAMPLE_SNAPSHOT_ID, {
                createdAt: 1, trigger: 'forcePull'
            }, {
                books: [{ id: 'rb1', lastActiveAt: originalTs, json: makeBookJson('rb1', originalTs) }],
                collections: [],
                tombstones: []
            });

            const before = Date.now();
            await backend.restoreSnapshot(SAMPLE_SNAPSHOT_ID);
            const after = Date.now();

            const liveBook = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey('books/rb1.json')
            );
            const liveTs = Number(liveBook.metadata['last-active']);
            expect(liveTs).toBeGreaterThanOrEqual(before);
            expect(liveTs).toBeLessThanOrEqual(after);
            expect(liveTs).not.toBe(originalTs);

            // Snapshot's copy MUST still hold the original.
            const snapBook = await inspectObject(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!,
                fullKey(`snapshots/${SAMPLE_SNAPSHOT_ID}/books/rb1.json`)
            );
            expect(snapBook.metadata['last-active']).toBe(String(originalTs));
        });

        it('clearTombstones → all keys under <prefix>/tombstones/<resource-dir>/ removed', async () => {
            await backend.writeTombstone('book', 'b1', 100);
            await backend.writeTombstone('book', 'b2', 200);
            await backend.writeTombstone('collection', 'c1', 300); // unrelated resource

            await backend.clearTombstones('book');

            const remaining = await listAllKeys(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!, `${prefix}/tombstones/`
            );
            // Only the collection tombstone survives.
            expect(remaining).toEqual([
                fullKey('tombstones/collections/c1/300')
            ]);
        });

        it('remove → key gone from bucket', async () => {
            await backend.write('book', 'gone', makeBookJson('gone', 1), 1);
            const before = await listAllKeys(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!, `${prefix}/books/`
            );
            expect(before).toEqual([fullKey('books/gone.json')]);

            await backend.remove('book', 'gone');

            const after = await listAllKeys(
                cleanupClient, sdk, process.env['S3_TEST_BUCKET']!, `${prefix}/books/`
            );
            expect(after).toEqual([]);
        });
    });
});
