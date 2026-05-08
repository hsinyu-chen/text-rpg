import { BlobListEntry, BlobStore } from '../blob-store';
import { RemoteEntry } from '../sync.types';
import { META_LAST_ACTIVE } from '../layout/sync-paths';

/**
 * Recovers `lastActiveAt` from a {@link BlobListEntry}'s metadata, falling
 * back to:
 *   1. The blob's own JSON body's `lastActiveAt` / `updatedAt` field
 *      (legacy uploads pre-`x-amz-meta-last-active` scheme, or browser
 *      CORS strip), if reachable.
 *   2. The blob's `modifiedAt` (server-side last-modified) as the final
 *      anchor — clock-skewed but always present.
 *
 * Caller passes the BlobStore so the body-fallback can issue a `read`
 * only when needed (skipped in the common path where metadata is intact).
 *
 * Why a separate helper: every backend's `list()` does the same recovery
 * dance against its own native list/read APIs — by reducing the inputs to
 * `BlobListEntry` + `BlobStore`, the recovery logic is the same regardless
 * of which backend we're talking to.
 */
export async function blobEntryToRemoteEntry(
    blob: BlobStore,
    listEntry: BlobListEntry,
    id: string
): Promise<RemoteEntry> {
    const fallback: RemoteEntry = {
        id,
        lastActiveAt: listEntry.modifiedAt,
        modifiedAt: listEntry.modifiedAt,
        etag: listEntry.etag,
        size: listEntry.size
    };

    const metaValue = listEntry.meta[META_LAST_ACTIVE];
    if (metaValue) {
        const n = Number(metaValue);
        return { ...fallback, lastActiveAt: Number.isFinite(n) && n > 0 ? n : listEntry.modifiedAt };
    }

    // Metadata missing — read body and parse out lastActiveAt / updatedAt.
    // Ignore read failures; modifiedAt is the final anchor.
    try {
        const body = await blob.read(listEntry.path);
        const parsed = JSON.parse(body.text) as { lastActiveAt?: number; updatedAt?: number };
        const bodyTime = Number(parsed.lastActiveAt ?? parsed.updatedAt);
        if (Number.isFinite(bodyTime) && bodyTime > 0) {
            return { ...fallback, lastActiveAt: bodyTime };
        }
    } catch {
        // fall through
    }
    return fallback;
}
