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

        const body = new URLSearchParams({
            client_id: environment.gcpOauthAppId_Tauri,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });
        if (environment.gcpOauthClientSecret_Tauri) {
            body.append('client_secret', environment.gcpOauthClientSecret_Tauri);
        }

        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error('Refresh Token Failed: ' + JSON.stringify(err));
        }

        const data = await res.json();
        console.log('[TauriPkceFlow] Token refreshed successfully');
        return {
            accessToken: data.access_token,
            expiresInSeconds: data.expires_in || 3599,
            refreshToken: data.refresh_token,
        };
    }

    private async listenForCode(): Promise<string> {
        const { listen } = await import('@tauri-apps/api/event');

        return new Promise<string>((resolve, reject) => {
            let unlistenPayload: (() => void) | undefined;
            let unlistenResponse: (() => void) | undefined;
            let unlistenUrl: (() => void) | undefined;

            const cleanup = () => {
                if (unlistenPayload) unlistenPayload();
                if (unlistenResponse) unlistenResponse();
                if (unlistenUrl) unlistenUrl();
            };

            void listen<string>('oauth://url', (event) => {
                console.log('[TauriPkceFlow] Received oauth://url:', event.payload);
                cleanup();
                resolve(event.payload);
            }).then(u => unlistenUrl = u);

            void listen<string>('oauth://payload', (event) => {
                console.log('[TauriPkceFlow] Received oauth://payload:', event.payload);
                cleanup();
                resolve(event.payload);
            }).then(u => unlistenPayload = u);

            void listen<string>('oauth-response', (event) => {
                console.log('[TauriPkceFlow] Received oauth-response:', event.payload);
                cleanup();
                resolve(event.payload);
            }).then(u => unlistenResponse = u);

            setTimeout(() => {
                cleanup();
                reject(new Error('OAuth Timeout'));
            }, 300000);
        });
    }

    private async exchangeCodeForToken(
        code: string, verifier: string, redirectUri: string
    ): Promise<OAuthFlowResult> {
        const body = new URLSearchParams({
            client_id: environment.gcpOauthAppId_Tauri,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
        });

        if (environment.gcpOauthClientSecret_Tauri) {
            body.append('client_secret', environment.gcpOauthClientSecret_Tauri);
        }

        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });

        const data = await res.json();
        if (data.access_token) {
            return {
                accessToken: data.access_token,
                expiresInSeconds: data.expires_in || 3599,
                refreshToken: data.refresh_token,
            };
        }
        throw new Error('Token Exchange Failed: ' + JSON.stringify(data));
    }
}
