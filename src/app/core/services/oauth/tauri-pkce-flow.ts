import { Injectable } from '@angular/core';
import { environment } from '../../../../environments/environment';
import { OAuthFlow, OAuthFlowResult, RefreshErrorClass, OAUTH_SCOPE } from './oauth-flow';

/**
 * Thrown by {@link TauriPkceFlow}'s token-endpoint POSTs (refresh,
 * authorization-code exchange) on either an HTTP failure or a
 * 200-with-no-access_token body. Carries Google's `error` field
 * (e.g. `invalid_grant`) as a structured property so the orchestrator
 * can classify the failure without substring-matching the message.
 */
export class TauriOAuthEndpointError extends Error {
    override readonly name = 'TauriOAuthEndpointError';

    constructor(message: string, readonly errorCode: string | undefined) {
        super(message);
    }
}

async function generateCodeVerifier(): Promise<string> {
    const array = new Uint8Array(32);
    globalThis.crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Tauri desktop OAuth flow using PKCE + Google's "Desktop app" client
 * type. Spawns a localhost loopback listener via the Tauri OAuth
 * plugin, opens the system browser to Google's auth page, and
 * exchanges the returned code for an access + refresh token pair.
 *
 * Tauri PKCE with Google requires a "Desktop app" client id AND its
 * client secret — Web-type client ids do not work here at all. Both
 * are read from `environment.ts` at build time per project memory:
 * there is no official Tauri build, so Tauri users always rebuild
 * from source with credentials baked in.
 */
@Injectable({ providedIn: 'root' })
export class TauriPkceFlow implements OAuthFlow {
    readonly refreshIncludesInteractive = false;

    classifyError(error: unknown): RefreshErrorClass {
        // TauriOAuthEndpointError carries Google's `error` field as a
        // structured property. invalid_grant means the saved refresh token
        // is dead; access_denied means the user clicked "Deny" on the
        // consent screen. Anything else (network failure, plain Error
        // wrappers, OAuth Timeout) maps to transient so we preserve state.
        if (error instanceof TauriOAuthEndpointError) {
            if (error.errorCode === 'invalid_grant') return 'invalid';
            if (error.errorCode === 'access_denied') return 'declined';
        }
        return 'transient';
    }

    async login(): Promise<OAuthFlowResult> {
        const { invoke } = await import('@tauri-apps/api/core');
        const { open } = await import('@tauri-apps/plugin-shell');

        const port = await invoke<number>('plugin:oauth|start');
        const redirectUri = `http://localhost:${port}`;

        const verifier = await generateCodeVerifier();
        const challenge = await generateCodeChallenge(verifier);

        // access_type=offline + prompt=consent ensures we get a refresh
        // token even if the user has authorised before.
        const clientId = environment.gcpOauthAppId_Tauri;
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
            `response_type=code` +
            `&client_id=${clientId}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&scope=${encodeURIComponent(OAUTH_SCOPE)}` +
            `&code_challenge=${challenge}` +
            `&code_challenge_method=S256` +
            `&access_type=offline` +
            `&prompt=consent`;

        console.log('[TauriPkceFlow] Opening Auth URL:', authUrl);

        // Two-phase: await registration BEFORE opening the browser, then
        // await the code arrival. Previously startCodeListener returned its
        // promise immediately (registration still in-flight), so a fast
        // OAuth redirect could arrive before listeners were active.
        const { codePromise } = await this.startCodeListener();

        await open(authUrl);

        const codeOrUrl = await codePromise;
        let code = codeOrUrl;
        if (codeOrUrl.includes('code=')) {
            // Standard 'oauth://url' delivers a full http://localhost URL;
            // legacy 'oauth://payload' / 'oauth-response' may deliver only
            // the query string (e.g. '?code=...'), which throws TypeError
            // when fed to `new URL()`. Fall back to URLSearchParams so
            // both shapes parse.
            try {
                code = new URL(codeOrUrl).searchParams.get('code') || '';
            } catch {
                code = new URLSearchParams(codeOrUrl.replace(/^\?/, '')).get('code') || '';
            }
        }
        if (!code) throw new Error('No code received');

        return this.exchangeCodeForToken(code, verifier, redirectUri);
    }

    async refresh(refreshToken: string | null): Promise<OAuthFlowResult> {
        if (!refreshToken) throw new Error('No refresh token available');
        const result = await this.tokenEndpointPost(
            this.buildAuthBody({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
            'Refresh Token'
        );
        console.log('[TauriPkceFlow] Token refreshed successfully');
        return result;
    }

    /**
     * Two-phase listener setup: the outer promise resolves once all event
     * listeners are registered; the returned `codePromise` resolves when
     * the actual OAuth code arrives. Caller must await the outer promise
     * before opening the system browser, then await `codePromise` to
     * receive the code.
     */
    private async startCodeListener(): Promise<{ codePromise: Promise<string> }> {
        const { listen } = await import('@tauri-apps/api/event');

        let resolveCode!: (s: string) => void;
        let rejectCode!: (e: unknown) => void;
        const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

        // Cleanup tracking: once the code arrives (or the timeout fires), all
        // outstanding listener registrations should be detached. Because each
        // listen() resolves on its own microtask, the first listener can fire
        // and complete cleanup() while sibling registrations are still pending
        // — those pending unlisten handles must detach themselves immediately
        // when they finally resolve, instead of joining a stale array.
        let isCleanedUp = false;
        const unlisteners: (() => void)[] = [];
        const cleanup = () => {
            isCleanedUp = true;
            for (const u of unlisteners) u();
            unlisteners.length = 0;
        };

        // Set the timeout BEFORE awaiting registrations so a hung listen()
        // IPC can't strand the promise without a deadline. cleanup() called
        // before any unlisteners are pushed is a no-op; isCleanedUp prevents
        // late-arriving registrations from adding stale handles.
        const timeout = setTimeout(() => {
            cleanup();
            rejectCode(new Error('OAuth Timeout'));
        }, 300000);

        const register = async (event: string) => {
            const u = await listen<string>(event, ({ payload }) => {
                console.log(`[TauriPkceFlow] Received ${event}:`, payload);
                cleanup();
                resolveCode(payload);
            });
            if (isCleanedUp) u();
            else unlisteners.push(u);
        };

        // 'oauth://url' is the standard Tauri v2 event; 'oauth://payload' /
        // 'oauth-response' cover custom / legacy names. Concurrent
        // registration shrinks the window where one event could fire while
        // siblings are still pending. If any registration rejects, detach
        // the siblings that did succeed before propagating.
        try {
            await Promise.all([
                register('oauth://url'),
                register('oauth://payload'),
                register('oauth-response'),
            ]);
        } catch (err) {
            cleanup();
            clearTimeout(timeout);
            rejectCode(err);
            throw err;
        }

        return { codePromise: codePromise.finally(() => clearTimeout(timeout)) };
    }

    private exchangeCodeForToken(
        code: string, verifier: string, redirectUri: string
    ): Promise<OAuthFlowResult> {
        return this.tokenEndpointPost(
            this.buildAuthBody({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                code_verifier: verifier,
            }),
            'Token Exchange'
        );
    }

    private buildAuthBody(extras: Record<string, string>): URLSearchParams {
        const body = new URLSearchParams({
            client_id: environment.gcpOauthAppId_Tauri,
            ...extras,
        });
        if (environment.gcpOauthClientSecret_Tauri) {
            body.append('client_secret', environment.gcpOauthClientSecret_Tauri);
        }
        return body;
    }

    /**
     * Single source of truth for Google OAuth token endpoint POSTs. Shapes
     * the response into {@link OAuthFlowResult} and throws a contextual
     * error on either HTTP failure or a 200-with-no-access_token body
     * (which Google does emit for some error shapes).
     */
    private async tokenEndpointPost(body: URLSearchParams, contextLabel: string): Promise<OAuthFlowResult> {
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new TauriOAuthEndpointError(
                `${contextLabel} Failed: ` + JSON.stringify(err),
                err.error
            );
        }

        const data = await res.json();
        if (!data.access_token) {
            throw new TauriOAuthEndpointError(
                `${contextLabel} Failed: ` + JSON.stringify(data),
                data.error
            );
        }

        return {
            accessToken: data.access_token,
            expiresInSeconds: data.expires_in || 3599,
            refreshToken: data.refresh_token,
        };
    }
}
