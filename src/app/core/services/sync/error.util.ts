/**
 * Coerce an arbitrary thrown value into a human-readable string for sync /
 * snapshot error reports. Walks the standard `Error.message` path first,
 * then handles bare strings, then probes objects for a `message` property
 * (the AWS / Drive SDK error shape), then falls back to `String(e)`.
 *
 * Lives in its own file because both `sync.service.ts` and
 * `snapshot.service.ts` need to format errors the same way — the strings
 * land in `SyncError.message` reports the UI eventually surfaces, so any
 * drift between the two sides shows up as inconsistent error UX.
 */
export function errMsg(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
        return (e as { message: string }).message;
    }
    return String(e);
}
