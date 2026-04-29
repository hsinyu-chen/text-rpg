// Custom service worker that wraps Angular's ngsw-worker.js so we keep the app
// shell caching behaviour while adding a message-driven fetch proxy. Page code
// posts {type: 'bgfetch:start', id, url, init, port} with a MessagePort; we own
// the upstream fetch and the response ReadableStream, forwarding chunks back
// through the port. This survives brief page suspension (mobile screen-off)
// because the SW thread keeps reading even when the page's JS pauses.
//
// iOS Safari kills the SW after ~30-60s of page-hidden inactivity even with
// active fetch, so this is mitigation, not a cure. Android Chrome is much
// more permissive.

importScripts('./ngsw-worker.js');

const inflight = new Map();

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'bgfetch:start' && data.port) {
        event.waitUntil(handleFetch(data.id, data.url, data.init, data.port));
    } else if (data.type === 'bgfetch:abort' && data.id) {
        const ctrl = inflight.get(data.id);
        if (ctrl) ctrl.abort();
    }
});

async function handleFetch(id, url, init, port) {
    const ctrl = new AbortController();
    inflight.set(id, ctrl);

    try {
        const resp = await fetch(url, { ...init, signal: ctrl.signal });
        if (!safePost(port, {
            type: 'head',
            status: resp.status,
            statusText: resp.statusText,
            headers: [...resp.headers]
        })) {
            // Page already gone — bail before opening the body reader.
            ctrl.abort();
            return;
        }
        if (!resp.body) {
            safePost(port, { type: 'done' });
            return;
        }
        const reader = resp.body.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!safePost(port, { type: 'chunk', value })) {
                // Port closed (page navigated away or got discarded) — abort the
                // upstream so we don't keep pulling bytes nobody can read.
                ctrl.abort();
                break;
            }
        }
        safePost(port, { type: 'done' });
    } catch (err) {
        const message = (err && err.message) ? String(err.message) : String(err);
        safePost(port, { type: 'error', message });
    } finally {
        inflight.delete(id);
        try { port.close(); } catch { /* noop */ }
    }
}

function safePost(port, msg) {
    try {
        port.postMessage(msg);
        return true;
    } catch {
        return false;
    }
}
