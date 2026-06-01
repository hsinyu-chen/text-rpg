/**
 * Build a standard `AbortController`-style error so the save orchestrator's
 * `isAbortError` check matches it. Used by advanced-save agents to surface an
 * abort that landed without the stream consumer rethrowing.
 */
export function makeAbortError(): Error {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
}
