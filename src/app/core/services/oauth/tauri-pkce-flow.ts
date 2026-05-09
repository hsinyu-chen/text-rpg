import { Injectable } from '@angular/core';
import { environment } from '../../../../environments/environment';
import { OAuthFlow, OAuthFlowResult, OAUTH_SCOPE } from './oauth-flow';

async function generateCodeVerifier(): Promise<string> {
    const array = new Uint8Array(32);
    globalThis.crypto.getRandomValues(array);
    return Array.from(array, dec2hex).join('');
}

function dec2hex(dec: number): string {
    return ('0' + dec.toString(16)).slice(-2);
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

        const codePromise = this.listenForCode();

        await open(authUrl);

        const codeOrUrl = await codePromise;
        let code = codeOrUrl;
        if (codeOrUrl.includes('code=')) {
            code = new URL(codeOrUrl).searchParams.get('code') || '';
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

    private async listenForCode(): Promise<string> {
        const { listen } = await import('@tauri-apps/api/event');

        let resolveCode!: (s: string) => void;
        let rejectCode!: (e: unknown) => void;
        const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

        const unlisteners: (() => void)[] = [];
        const cleanup = () => {
            for (const u of unlisteners) u();
            unlisteners.length = 0;
        };

        const onCode = (label: string) => (event: { payload: string }) => {
            console.log(`[TauriPkceFlow] Received ${label}:`, event.payload);
            cleanup();
            resolveCode(event.payload);
        };

        // Await each registration so the unlisten handle is captured before
        // any event can fire — fire-and-forget with .then(u => ...) leaks
        // the handle on a fast click-through (cleanup runs while u is still
        // undefined). 'oauth://url' is the standard Tauri v2 event;
        // 'oauth://payload' / 'oauth-response' cover custom / legacy names.
        unlisteners.push(await listen<string>('oauth://url', onCode('oauth://url')));
        unlisteners.push(await listen<string>('oauth://payload', onCode('oauth://payload')));
        unlisteners.push(await listen<string>('oauth-response', onCode('oauth-response')));

        const timeout = setTimeout(() => {
            cleanup();
            rejectCode(new Error('OAuth Timeout'));
        }, 300000);

        return codePromise.finally(() => clearTimeout(timeout));
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
            throw new Error(`${contextLabel} Failed: ` + JSON.stringify(err));
        }

        const data = await res.json();
        if (!data.access_token) {
            throw new Error(`${contextLabel} Failed: ` + JSON.stringify(data));
        }

        return {
            accessToken: data.access_token,
            expiresInSeconds: data.expires_in || 3599,
            refreshToken: data.refresh_token,
        };
    }
}
