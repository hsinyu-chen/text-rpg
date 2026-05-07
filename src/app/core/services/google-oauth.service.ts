import { Injectable, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { environment } from '../../../environments/environment';
import { KVStore } from './kv/kv-store';

// ===== Google Identity Services types ===================================

interface TokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
    error?: string;
    error_description?: string;
}

interface TokenClientConfig {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type: string; message: string }) => void;
}

interface TokenClient {
    callback: (response: TokenResponse) => void;
    requestAccessToken: (overrideConfig?: { prompt?: string; hint?: string }) => void;
}

interface GoogleAccountsOAuth2 {
    initTokenClient: (config: TokenClientConfig) => TokenClient;
}

interface GoogleAccounts {
    oauth2: GoogleAccountsOAuth2;
}

interface Google {
    accounts: GoogleAccounts;
}

declare const google: Google | undefined;

interface WindowWithTauri extends Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
}

declare const window: WindowWithTauri;

// ===== PKCE helpers =====================================================

async function generateCodeVerifier(): Promise<string> {
    const array = new Uint8Array(32);
    globalThis.crypto.getRandomValues(array);
    return Array.from(array, dec2hex).join('');
}
function dec2hex(dec: number): string {
    return ('0' + dec.toString(16)).substr(-2);
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

// BYO OAuth is web-only: there is no official Tauri distribution, so Tauri
// users always rebuild from source with credentials baked into environment.ts
// (Tauri PKCE additionally requires GCP "Desktop app" type + secret, which
// is awkward to enter through a runtime UI). Only the web client id has a
// runtime fallback.
const LS_OAUTH_CLIENT_ID = 'gdrive_oauth_client_id';
const LS_ACCESS_TOKEN = 'gdrive_access_token';
const LS_REFRESH_TOKEN = 'gdrive_refresh_token';
const LS_TOKEN_EXPIRY = 'gdrive_token_expiry';
const LS_USER_EMAIL = 'gdrive_user_email';

// Scopes requested by both Web (GIS popup) and Tauri (PKCE) flows. `email`
// is needed for the user-info hint that lets `loginWeb` attempt a silent
// re-login; `drive.appdata` is the actual sync scope.
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.appdata email';

interface OAuthCreds {
    clientId: string;
    clientIdTauri: string;
    clientSecretTauri: string;
}

/**
 * Owns the Google OAuth lifecycle: credential resolution (env vs runtime
 * config), GIS script loading, token state (access + refresh + expiry),
 * Web (popup) and Tauri (PKCE) login flows, silent refresh, and the
 * `getValidToken` accessor that Drive REST callers use to authenticate
 * each request.
 *
 * Drive REST itself lives in `GoogleDriveService`, which depends on this
 * service for token acquisition and 401-retry seam.
 */
@Injectable({ providedIn: 'root' })
export class GoogleOAuthService {
    private readonly doc = inject(DOCUMENT);
    private readonly kv = inject(KVStore);

    private tokenClient: TokenClient | null = null;
    private accessToken = signal<string | null>(null);
    private refreshToken = signal<string | null>(null);
    private tokenExpiry = signal<number>(0);

    private isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

    // Tracks whether the GIS script has been requested so we don't append a
    // second <script> when reinitClient() runs (e.g. user pasted creds after
    // boot in a build whose environment was empty).
    private gisScriptLoading = false;
    private gisScript: HTMLScriptElement | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        const savedToken = this.kv.get(LS_ACCESS_TOKEN);
        const savedRefreshToken = this.kv.get(LS_REFRESH_TOKEN);
        const savedExpiry = this.kv.get(LS_TOKEN_EXPIRY);

        if (savedToken) {
            this.accessToken.set(savedToken);
            if (savedExpiry) {
                this.tokenExpiry.set(parseInt(savedExpiry, 10));
            }
        }
        if (savedRefreshToken) {
            this.refreshToken.set(savedRefreshToken);
            console.log('[GoogleOAuth] Restored refresh token from storage');
        }

        console.log('[GoogleOAuth] Service initialized. Token expiry:', new Date(this.tokenExpiry()).toLocaleString());
        if (this.isConfigured) {
            this.loadScripts();
        }
    }

    /**
     * Resolves OAuth credentials. The Web client id falls back to a
     * user-supplied runtime value when `environment.gcpOauthAppId`
     * is empty (BYO OAuth in web builds). Tauri-specific creds are read
     * from environment only — see project memory: there is no official
     * Tauri build, so Tauri users always rebuild with env baked in, and
     * the runtime UI deliberately doesn't ask for them.
     */
    private resolveOAuthCreds(): OAuthCreds {
        return {
            clientId: environment.gcpOauthAppId || this.kv.get(LS_OAUTH_CLIENT_ID) || '',
            clientIdTauri: environment.gcpOauthAppId_Tauri,
            clientSecretTauri: environment.gcpOauthClientSecret_Tauri
        };
    }

    get isConfigured(): boolean {
        return this.resolveOAuthCreds().clientId.length > 0;
    }

    /** Whether the running build has the web client id slot empty and
     *  therefore exposes the BYO OAuth input field in Settings. Web-only:
     *  Tauri users always rebuild from source. */
    get isUserConfigurable(): boolean {
        return !environment.gcpOauthAppId && !this.isTauri;
    }

    /** Snapshot of the currently-effective web client id — used by the
     *  config UI to prefill the input. */
    getOAuthClientIdSnapshot(): string {
        return this.resolveOAuthCreds().clientId;
    }

    isAuthenticated(): boolean {
        return this.accessToken() !== null && Date.now() < this.tokenExpiry();
    }

    private loadScripts(): void {
        if (this.gisScriptLoading) {
            // Script already requested; if it's done loading, just (re)init.
            if (typeof google !== 'undefined') this.initClient();
            return;
        }
        this.gisScriptLoading = true;
        const script = this.doc.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => this.initClient();
        // If the script fails to load (ad blocker, offline, corp network
        // blocking accounts.google.com), reset the flag and detach the
        // failed tag so a later reinitClient() can append a fresh one
        // instead of silently no-oping or stacking dead <script> nodes.
        script.onerror = () => {
            console.warn('[GoogleOAuth] Failed to load GIS script (network blocked?)');
            this.gisScriptLoading = false;
            script.remove();
            if (this.gisScript === script) this.gisScript = null;
        };
        this.gisScript = script;
        this.doc.body.appendChild(script);
    }

    private initClient(): void {
        if (typeof google === 'undefined') return;

        const { clientId } = this.resolveOAuthCreds();
        if (!clientId) return;

        this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: OAUTH_SCOPE,
            callback: (tokenResponse: TokenResponse) => {
                if (tokenResponse && tokenResponse.access_token) {
                    this.handleLoginSuccess(tokenResponse.access_token, tokenResponse.expires_in);
                }
            },
        });
    }

    /**
     * Persists the user-supplied web Client ID and rebuilds the token
     * client. Old tokens are cleared because they were issued by the
     * previous client id and refreshing them would fail — better to force
     * a fresh interactive login on the next sync.
     *
     * Clearing creds (empty input) drops the existing tokenClient so
     * subsequent calls don't accidentally reach Google with the previous
     * client id.
     */
    saveOAuthClientId(clientId: string): void {
        const trimmed = clientId.trim();
        if (trimmed) this.kv.set(LS_OAUTH_CLIENT_ID, trimmed);
        else this.kv.remove(LS_OAUTH_CLIENT_ID);
        this.clearTokens();
        if (!this.isConfigured) {
            this.tokenClient = null;
            return;
        }
        this.reinitClient();
    }

    /**
     * Public hook to (re)build the GIS token client after creds change. Safe
     * to call repeatedly: `initTokenClient` overwrites the previous instance
     * and the script loader is idempotent.
     */
    reinitClient(): void {
        if (!this.isConfigured) return;
        if (typeof google === 'undefined') {
            this.loadScripts();
            return;
        }
        this.initClient();
    }

    private handleLoginSuccess(token: string, expiresInSeconds = 3599, refreshToken?: string): void {
        this.accessToken.set(token);

        // Set expiry slightly before actual expiry (5 min buffer for isAuthenticated()).
        const now = Date.now();
        const expiryBufferSeconds = 300;
        const expiry = now + (expiresInSeconds - expiryBufferSeconds) * 1000;
        this.tokenExpiry.set(expiry);

        this.kv.set(LS_ACCESS_TOKEN, token);
        this.kv.set(LS_TOKEN_EXPIRY, expiry.toString());

        if (refreshToken) {
            this.refreshToken.set(refreshToken);
            this.kv.set(LS_REFRESH_TOKEN, refreshToken);
            console.log('[GoogleOAuth] Refresh token saved');
        }

        if (!this.kv.get(LS_USER_EMAIL)) {
            void this.fetchAndSaveUserEmail(token);
        }

        this.scheduleAutoRefresh(expiresInSeconds);
    }

    private scheduleAutoRefresh(expiresInSeconds: number): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }

        // Refresh 5 minutes before actual expiry, with a 10s minimum so very
        // short test tokens still refresh.
        const refreshDelaySeconds = Math.max(10, expiresInSeconds - 300);
        const delayMs = refreshDelaySeconds * 1000;

        console.log(`[GoogleOAuth] Scheduling silent refresh in ${refreshDelaySeconds} seconds`);

        this.refreshTimer = setTimeout(() => {
            void this.performSilentRefresh();
        }, delayMs);
    }

    private async performSilentRefresh(): Promise<void> {
        console.log('[GoogleOAuth] Performing proactive silent refresh...');
        try {
            // Refresh token (Tauri/Desktop) takes priority; fall back to
            // silent web login if no refresh token is present.
            if (this.refreshToken()) {
                await this.refreshAccessToken();
            } else {
                await this.loginWeb(false);
            }
            console.log('[GoogleOAuth] Proactive refresh successful');
        } catch (e) {
            console.warn('[GoogleOAuth] Proactive refresh failed. Will wait for manual interaction.', e);
        }
    }

    private async fetchAndSaveUserEmail(token: string): Promise<void> {
        try {
            const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${token}` },
                cache: 'no-store'
            });
            if (res.ok) {
                const data = await res.json();
                if (data.email) {
                    this.kv.set(LS_USER_EMAIL, data.email);
                    console.log('[GoogleOAuth] User email saved for hint:', data.email);
                }
            }
        } catch (e) {
            console.warn('[GoogleOAuth] Failed to fetch user info', e);
        }
    }

    async login(): Promise<string> {
        if (this.accessToken() && Date.now() < this.tokenExpiry()) {
            return this.accessToken()!;
        }

        if (this.refreshToken()) {
            try {
                console.log('[GoogleOAuth] Access token expired, attempting silent refresh...');
                return await this.refreshAccessToken();
            } catch (error) {
                console.warn('[GoogleOAuth] Silent refresh failed, falling back to interactive login:', error);
                this.clearTokens();
            }
        }

        return this.isTauri ? this.loginTauri() : this.loginWeb();
    }

    private clearTokens(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.accessToken.set(null);
        this.refreshToken.set(null);
        this.tokenExpiry.set(0);
        this.kv.remove(LS_ACCESS_TOKEN);
        this.kv.remove(LS_REFRESH_TOKEN);
        this.kv.remove(LS_TOKEN_EXPIRY);
    }

    private async refreshAccessToken(): Promise<string> {
        const refreshToken = this.refreshToken();
        if (!refreshToken) throw new Error('No refresh token available');

        const creds = this.resolveOAuthCreds();
        const clientId = this.isTauri ? creds.clientIdTauri : creds.clientId;
        // Tauri (Desktop-app client) requires the client secret on the refresh
        // call. Web GIS doesn't issue a refresh token in the popup token
        // model, so this branch only runs on Tauri in practice — but keep
        // the secret-empty guard for symmetry with exchangeCodeForToken.
        const clientSecret = this.isTauri ? creds.clientSecretTauri : '';

        const body = new URLSearchParams({
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });
        if (clientSecret) body.append('client_secret', clientSecret);

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
        const newAccessToken = data.access_token;
        const expiresIn = data.expires_in || 3599;

        console.log('[GoogleOAuth] Token refreshed successfully');
        this.handleLoginSuccess(newAccessToken, expiresIn, data.refresh_token);
        return newAccessToken;
    }

    private async loginTauri(): Promise<string> {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const { open } = await import('@tauri-apps/plugin-shell');

            // 1. Start OAuth Server
            const port = await invoke<number>('plugin:oauth|start');
            const redirectUri = `http://localhost:${port}`;

            // 2. Prepare PKCE
            const verifier = await generateCodeVerifier();
            const challenge = await generateCodeChallenge(verifier);

            // 3. Build URL. access_type=offline + prompt=consent ensures we
            //    get a refresh token even if the user has authorised before.
            const clientId = this.resolveOAuthCreds().clientIdTauri;
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                `response_type=code` +
                `&client_id=${clientId}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&scope=${encodeURIComponent(OAUTH_SCOPE)}` +
                `&code_challenge=${challenge}` +
                `&code_challenge_method=S256` +
                `&access_type=offline` +
                `&prompt=consent`;

            console.log('[GoogleOAuth] Opening Auth URL:', authUrl);

            // 4. Listen for code (REGISTER BEFORE OPENING BROWSER).
            const { listen } = await import('@tauri-apps/api/event');

            const codePromise = new Promise<string>((resolve, reject) => {
                let unlistenPayload: (() => void) | undefined;
                let unlistenResponse: (() => void) | undefined;
                let unlistenUrl: (() => void) | undefined;

                const cleanup = () => {
                    if (unlistenPayload) unlistenPayload();
                    if (unlistenResponse) unlistenResponse();
                    if (unlistenUrl) unlistenUrl();
                };

                // Standard Tauri v2 event
                void listen<string>('oauth://url', (event) => {
                    console.log('[GoogleOAuth] Received oauth://url:', event.payload);
                    cleanup();
                    resolve(event.payload);
                }).then(u => unlistenUrl = u);

                // Custom / legacy event names
                void listen<string>('oauth://payload', (event) => {
                    console.log('[GoogleOAuth] Received oauth://payload:', event.payload);
                    cleanup();
                    resolve(event.payload);
                }).then(u => unlistenPayload = u);

                void listen<string>('oauth-response', (event) => {
                    console.log('[GoogleOAuth] Received oauth-response:', event.payload);
                    cleanup();
                    resolve(event.payload);
                }).then(u => unlistenResponse = u);

                setTimeout(() => {
                    cleanup();
                    reject(new Error('OAuth Timeout'));
                }, 300000);
            });

            await open(authUrl);

            const codeOrUrl = await codePromise;
            let code = codeOrUrl;
            if (codeOrUrl.includes('code=')) {
                code = new URL(codeOrUrl).searchParams.get('code') || '';
            }
            if (!code) throw new Error('No code received');

            // 5. Exchange Token
            const { token, expires_in, refresh_token } = await this.exchangeCodeForToken(code, verifier, redirectUri);
            this.handleLoginSuccess(token, expires_in, refresh_token);
            return token;
        } catch (e) {
            console.error('Tauri Login Error', e);
            throw e;
        }
    }

    private async exchangeCodeForToken(
        code: string, verifier: string, redirectUri: string
    ): Promise<{ token: string; expires_in: number; refresh_token?: string }> {
        const creds = this.resolveOAuthCreds();
        const body = new URLSearchParams({
            client_id: creds.clientIdTauri,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
        });

        // Tauri PKCE flow with Google requires a "Desktop app" type client id
        // AND its client secret — Web-type client ids do not work here at all.
        if (creds.clientSecretTauri) {
            body.append('client_secret', creds.clientSecretTauri);
        }

        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });

        const data = await res.json();
        if (data.access_token) {
            return {
                token: data.access_token,
                expires_in: data.expires_in || 3599,
                refresh_token: data.refresh_token
            };
        }
        throw new Error('Token Exchange Failed: ' + JSON.stringify(data));
    }

    private loginWeb(forceInteractive = false): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.tokenClient) {
                this.initClient();
                if (!this.tokenClient) {
                    reject('Google Sign-In not initialized');
                    return;
                }
            }

            this.tokenClient.callback = (resp: TokenResponse) => {
                if (resp.error) {
                    if (!forceInteractive && (resp.error === 'interaction_required' || resp.error === 'login_required')) {
                        console.warn('[GoogleOAuth] Silent login failed, triggering interactive mode...');
                        this.loginWeb(true).then(resolve).catch(reject);
                        return;
                    }
                    reject(resp);
                } else {
                    this.handleLoginSuccess(resp.access_token, resp.expires_in);
                    resolve(resp.access_token);
                }
            };

            const savedEmail = this.kv.get(LS_USER_EMAIL);
            const config: { prompt?: string; hint?: string } = {};

            if (!forceInteractive && savedEmail) {
                config.hint = savedEmail;
                config.prompt = ''; // Try silent
            } else {
                config.prompt = 'consent'; // Force interactive
            }

            console.log('[GoogleOAuth] Requesting Web Token. Config:', config);
            this.tokenClient.requestAccessToken(config);
        });
    }

    /**
     * Returns a non-expired access token, refreshing or re-authenticating
     * as needed. Drive REST callers (`GoogleDriveService.execute`) wrap
     * this with 401-retry; clients that just want a token for a one-off
     * fetch can call this directly.
     */
    async getValidToken(): Promise<string> {
        if (this.accessToken() && Date.now() < this.tokenExpiry()) {
            return this.accessToken()!;
        }

        // Tauri: refresh-token path first
        if (this.isTauri && this.refreshToken()) {
            try {
                console.log('[GoogleOAuth] Tauri: Access token expired, refreshing...');
                return await this.refreshAccessToken();
            } catch (e) {
                console.warn('[GoogleOAuth] Tauri refresh failed, falling back to login.', e);
            }
        }

        // Web (or failed Tauri refresh): full re-auth
        console.log('[GoogleOAuth] Token expired or missing. Triggering re-auth...');
        return this.isTauri ? this.loginTauri() : this.loginWeb();
    }

    /**
     * 401 retry primitive used by Drive REST: forces a refresh (or a fresh
     * interactive login if no refresh token / refresh fails) and returns
     * the new access token. Caller re-runs the original request with it.
     */
    async forceReauthAfter401(): Promise<string> {
        console.warn('[GoogleOAuth] 401 Unauthorized encountered. Retry logic...');
        if (this.refreshToken()) {
            try {
                return await this.refreshAccessToken();
            } catch (refreshErr) {
                console.warn('[GoogleOAuth] Retry refresh failed', refreshErr);
            }
        }
        // No refresh token or refresh failed: clear + interactive re-login.
        this.clearTokens();
        return this.login();
    }

    /** True iff this 401-shaped error should trigger the re-auth-and-retry seam. */
    static isUnauthorized(err: unknown): boolean {
        const e = err as { status?: number; message?: string };
        return e?.status === 401 || (!!e?.message && e.message.includes('401'));
    }
}
