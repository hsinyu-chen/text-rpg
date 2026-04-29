import { Injectable, inject } from '@angular/core';
import { WINDOW } from '../tokens/window.token';

interface BgFetchHeadMessage {
    type: 'head';
    status: number;
    statusText: string;
    headers: [string, string][];
}
interface BgFetchChunkMessage { type: 'chunk'; value: Uint8Array; }
interface BgFetchDoneMessage { type: 'done'; }
interface BgFetchErrorMessage { type: 'error'; message: string; }
type BgFetchMessage =
    | BgFetchHeadMessage
    | BgFetchChunkMessage
    | BgFetchDoneMessage
    | BgFetchErrorMessage;

interface SerializedInit {
    method: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer | ArrayBufferView;
    mode?: RequestMode;
    credentials?: RequestCredentials;
    cache?: RequestCache;
    redirect?: RequestRedirect;
    referrer?: string;
    referrerPolicy?: ReferrerPolicy;
    integrity?: string;
}

/**
 * Routes selected fetches through the service worker so the upstream connection
 * is owned by the SW thread. Survives brief page suspension on mobile (screen
 * locked, app backgrounded) because the SW keeps reading even when the page
 * pauses; chunks queue on the MessagePort and drain when the page resumes.
 *
 * Currently scoped to Gemini's host — that's where the long streaming requests
 * live. Other providers can opt in by extending shouldRoute().
 */
@Injectable({ providedIn: 'root' })
export class BackgroundFetchService {
    private win = inject(WINDOW);
    private installed = false;
    private nextId = 0;

    install(): void {
        if (this.installed) return;
        if (!('serviceWorker' in this.win.navigator)) return;
        const sw = this.win.navigator.serviceWorker;

        const original: typeof fetch = this.win.fetch.bind(this.win);

        const shim = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = this.urlOf(input);
            const controller = sw.controller;
            // Skip routing if the body isn't trivially clonable — fallback would
            // otherwise re-read an already-consumed Blob/FormData/ReadableStream.
            if (!controller || !this.shouldRoute(url) || !this.canRouteBody(init?.body)) {
                return original(input, init);
            }
            return this.bgFetch(controller, url, init).catch((err) => {
                // Routing failed before the response opened — direct fetch as a
                // fallback so a SW glitch doesn't break the user's turn. Safe
                // because the body got reused only as a string/ArrayBuffer.
                console.warn('[bg-fetch] proxy failed, falling back to direct fetch', err);
                return original(input, init);
            });
        };

        this.win.fetch = shim as typeof fetch;
        this.installed = true;
    }

    private urlOf(input: RequestInfo | URL): string {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.href;
        return input.url;
    }

    private shouldRoute(url: string): boolean {
        return /^https:\/\/generativelanguage\.googleapis\.com\//.test(url);
    }

    private canRouteBody(body: BodyInit | null | undefined): boolean {
        if (body == null) return true;
        if (typeof body === 'string') return true;
        if (body instanceof ArrayBuffer) return true;
        if (ArrayBuffer.isView(body)) return true;
        return false;
    }

    private async bgFetch(controller: ServiceWorker, url: string, init: RequestInit | undefined): Promise<Response> {
        const id = `bg-${Date.now()}-${this.nextId++}`;
        const channel = new MessageChannel();

        let opened = false;
        let bodyClosed = false;
        let bodyController!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start: (c) => { bodyController = c; },
            cancel: () => {
                // port1.close() blocks future deliveries but messages already dispatched
                // into the page queue still reach onmessage — flag bodyClosed so those
                // late chunks no-op instead of throwing on a cancelled stream.
                bodyClosed = true;
                try { controller.postMessage({ type: 'bgfetch:abort', id }); } catch { /* noop */ }
                try { channel.port1.close(); } catch { /* noop */ }
            }
        });

        let respResolve!: (r: Response) => void;
        let respReject!: (e: Error) => void;
        const respPromise = new Promise<Response>((res, rej) => {
            respResolve = res;
            respReject = rej;
        });
        channel.port1.onmessage = (e: MessageEvent<BgFetchMessage>) => {
            const msg = e.data;
            if (!msg) return;
            switch (msg.type) {
                case 'head': {
                    opened = true;
                    respResolve(new Response(body, {
                        status: msg.status,
                        statusText: msg.statusText,
                        headers: new Headers(msg.headers)
                    }));
                    break;
                }
                case 'chunk': {
                    if (!bodyClosed) bodyController.enqueue(msg.value);
                    break;
                }
                case 'done': {
                    if (!bodyClosed) {
                        bodyController.close();
                        bodyClosed = true;
                    }
                    break;
                }
                case 'error': {
                    const err = new Error(msg.message);
                    if (!opened) {
                        respReject(err);
                    } else if (!bodyClosed) {
                        bodyController.error(err);
                        bodyClosed = true;
                    }
                    break;
                }
            }
        };

        const serialized = this.serializeInit(init);
        controller.postMessage(
            { type: 'bgfetch:start', id, url, init: serialized, port: channel.port2 },
            [channel.port2]
        );
        return respPromise;
    }

    private serializeInit(init: RequestInit | undefined): SerializedInit {
        const out: SerializedInit = { method: init?.method ?? 'GET' };
        if (!init) return out;
        if (init.headers) {
            out.headers = Object.fromEntries(new Headers(init.headers));
        }
        if (init.mode) out.mode = init.mode;
        if (init.credentials) out.credentials = init.credentials;
        if (init.cache) out.cache = init.cache;
        if (init.redirect) out.redirect = init.redirect;
        if (init.referrer) out.referrer = init.referrer;
        if (init.referrerPolicy) out.referrerPolicy = init.referrerPolicy;
        if (init.integrity) out.integrity = init.integrity;

        // canRouteBody in install() guarantees the body is null/string/ArrayBuffer
        // by the time we get here — Blob/FormData/Stream bodies skip the route.
        if (init.body !== undefined && init.body !== null) {
            const b = init.body;
            if (typeof b === 'string') {
                out.body = b;
            } else if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) {
                out.body = b as ArrayBuffer | ArrayBufferView;
            }
        }
        return out;
    }
}
