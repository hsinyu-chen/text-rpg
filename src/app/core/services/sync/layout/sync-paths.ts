import { SyncResource } from '../sync.types';

/**
 * Single source of truth for the on-disk path layout shared by every
 * BlobStore-backed sync backend. Changing a constant here changes the
 * layout on EVERY backend simultaneously — which is intentional, since
 * cross-device readers must agree.
 *
 * Live tree layout:
 *   `<RESOURCE_DIR[r]>/<id>.json`                       (entries)
 *   `<TOMBSTONE_DIR[r]>/<id>/<deletedAt>`               (tombstones)
 *   `settings.json`                                     (settings)
 *   `prompts.json`                                      (prompts)
 *
 * Snapshot tree layout (nested under `snapshots/<sid>/`):
 *   `manifest.json`
 *   `<RESOURCE_DIR[r]>/<id>.json`
 *   `tombstones/<RESOURCE_DIR[r]>/<id>/<deletedAt>`
 */

export const RESOURCE_DIR: Record<SyncResource, string> = {
    book: 'books',
    collection: 'collections'
};

export const TOMBSTONE_DIR: Record<SyncResource, string> = {
    book: 'tombstones/books',
    collection: 'tombstones/collections'
};

export const SETTINGS_KEY = 'settings.json';
export const PROMPTS_KEY = 'prompts.json';

export const SNAPSHOTS_DIR = 'snapshots';

/** User-metadata key for an entry's device-clock activity time.
 *  Hyphen rather than underscore — RFC 7230 disallows `_` in HTTP header
 *  names, and SeaweedFS rejects SigV4 of `x-amz-meta-last_active` outright.
 *  AWS S3 itself tolerates `_` but hyphen works on both. */
export const META_LAST_ACTIVE = 'last-active';

export function entryPath(resource: SyncResource, id: string): string {
    return `${RESOURCE_DIR[resource]}/${id}.json`;
}

export function tombstonePath(resource: SyncResource, id: string, deletedAt: number): string {
    return `${TOMBSTONE_DIR[resource]}/${id}/${deletedAt}`;
}

export function tombstoneDirPrefix(resource: SyncResource): string {
    return `${TOMBSTONE_DIR[resource]}/`;
}

export function entryDirPrefix(resource: SyncResource): string {
    return `${RESOURCE_DIR[resource]}/`;
}
