import { Injectable, signal } from '@angular/core';
import { environment } from '../../../environments/environment';

// Google Identity Services Types
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

export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    modifiedTime?: string;
    size?: string;
    md5Checksum?: string;
    appProperties?: Record<string, string>;
}

// Minimal PKCE Helpers
async function generateCodeVerifier() {
    const array = new Uint8Array(32);
    window.crypto.getRandomValues(array);
    return Array.from(array, dec2hex).join('');
}
function dec2hex(dec: number) {
    return ('0' + dec.toString(16)).substr(-2);
}
async function generateCodeChallenge(verifier: string) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// BYO OAuth is web-only: there is no official Tauri distribution, so Tauri
// users always rebuild from source with credentials baked into environment.ts
// (Tauri PKCE additionally requires GCP "Desktop app" type + secret, which
// is awkward to enter through a runtime UI). Only the web client id has an
// LS fallback.
const LS_OAUTH_CLIENT_ID = 'gdrive_oauth_client_id';

interface OAuthCreds {
    clientId: string;
    clientIdTauri: string;
    clientSecretTauri: string;
}

@Injectable({
    providedIn: 'root'
})
export class GoogleDriveService {
    private tokenClient: TokenClient | null = null;
    private accessToken = signal<string | null>(null);
    private refreshToken = signal<string | null>(null);
    private tokenExpiry = signal<number>(0);

    // Tauri detection
    private isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

    // Tracks whether the GIS script has been requested so we don't append a
    // second <script> when reinitClient() runs (e.g. user pasted creds after
    // boot in a build whose environment was empty).
    private gisScriptLoading = false;

    constructor() {
        // Restore token from localStorage if available
        const savedToken = localStorage.getItem('gdrive_access_token');
        const savedRefreshToken = localStorage.getItem('gdrive_refresh_token');
        const savedExpiry = localStorage.getItem('gdrive_token_expiry');

        if (savedToken) {
            this.accessToken.set(savedToken);
            if (savedExpiry) {
                this.tokenExpiry.set(parseInt(savedExpiry, 10));
            }
        }
        if (savedRefreshToken) {
            this.refreshToken.set(savedRefreshToken);
            console.log('[GoogleDrive] Restored refresh token from localStorage');
        }

        console.log('[GoogleDrive] Service initialized. Token expiry:', new Date(this.tokenExpiry()).toLocaleString());
        if (this.isConfigured) {
            this.loadScripts();
        }
    }

    /**
     * Resolves OAuth credentials. The Web client id falls back to a
     * user-supplied value in localStorage when `environment.gcpOauthAppId`
     * is empty (BYO OAuth in web builds). Tauri-specific creds are read
     * from environment only — see project memory: there is no official
     * Tauri build, so Tauri users always rebuild with env baked in, and
     * the runtime UI deliberately doesn't ask for them.
     */
    private resolveOAuthCreds(): OAuthCreds {
        return {
            clientId: environment.gcpOauthAppId || localStorage.getItem(LS_OAUTH_CLIENT_ID) || '',
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

    private loadScripts() {
        if (this.gisScriptLoading) {
            // Script already requested; if it's done loading, just (re)init.
            if (typeof google !== 'undefined') this.initClient();
            return;
        }
        this.gisScriptLoading = true;
        // Load Google Identity Services (GIS)
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => this.initClient();
        // If the script fails to load (ad blocker, offline, corp network
        // blocking accounts.google.com), reset the flag so a later
        // reinitClient() will try again instead of silently no-oping.
        script.onerror = () => {
            console.warn('[GoogleDrive] Failed to load GIS script (network blocked?)');
            this.gisScriptLoading = false;
        };
        document.body.appendChild(script);
    }

    private initClient() {
        if (typeof google === 'undefined') return;

        const { clientId } = this.resolveOAuthCreds();
        if (!clientId) return;

        this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/drive.appdata email',
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
     */
    saveOAuthClientId(clientId: string): void {
        const trimmed = clientId.trim();
        if (trimmed) localStorage.setItem(LS_OAUTH_CLIENT_ID, trimmed);
        else localStorage.removeItem(LS_OAUTH_CLIENT_ID);
        this.clearTokens();
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

    private refreshTimer: ReturnType<typeof setTimeout> | null = null;

    private handleLoginSuccess(token: string, expiresInSeconds = 3599, refreshToken?: string) {
        this.accessToken.set(token);

        // Expiry calculation
        const now = Date.now();
        // Set expiry to slightly before actual expiry (e.g., 5 min buffer)
        // We use this buffer for "isAuthenticated()" check
        const expiryBufferSeconds = 300;
        const expiry = now + (expiresInSeconds - expiryBufferSeconds) * 1000;
        this.tokenExpiry.set(expiry);

        localStorage.setItem('gdrive_access_token', token);
        localStorage.setItem('gdrive_token_expiry', expiry.toString());

        if (refreshToken) {
            this.refreshToken.set(refreshToken);
            localStorage.setItem('gdrive_refresh_token', refreshToken);
            console.log('[GoogleDrive] Refresh token saved');
        }

        // Fetch user email if not present (for login hints)
        if (!localStorage.getItem('gdrive_user_email')) {
            this.fetchAndSaveUserEmail(token);
        }

        // Schedule proactive refresh
        this.scheduleAutoRefresh(expiresInSeconds);
    }

    private scheduleAutoRefresh(expiresInSeconds: number) {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }

        // Refresh 4 minutes before actual expiry (giving 1 min overlap with our 5min buffer)
        // If expiresInSeconds is very short (e.g. testing), refresh halfway.
        const refreshDelaySeconds = Math.max(10, expiresInSeconds - 300); // Trigger 5 mins before real expiry
        const delayMs = refreshDelaySeconds * 1000;

        console.log(`[GoogleDrive] Scheduling silent refresh in ${refreshDelaySeconds} seconds`);

        this.refreshTimer = setTimeout(() => {
            void this.performSilentRefresh();
        }, delayMs);
    }

    private async performSilentRefresh() {
        console.log('[GoogleDrive] Performing proactive silent refresh...');
        try {
            // Try refresh token first (Desktop/Tauri)
            if (this.refreshToken()) {
                await this.refreshAccessToken();
            } else {
                // Try silent web login (Web)
                await this.loginWeb(false);
            }
            console.log('[GoogleDrive] Proactive refresh successful');
        } catch (e) {
            console.warn('[GoogleDrive] Proactive refresh failed. Will wait for manual interaction.', e);
        }
    }

    private async fetchAndSaveUserEmail(token: string) {
        try {
            const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${token}` },
                cache: 'no-store'
            });
            if (res.ok) {
                const data = await res.json();
                if (data.email) {
                    localStorage.setItem('gdrive_user_email', data.email);
                    console.log('[GoogleDrive] User email saved for hint:', data.email);
                }
            }
        } catch (e) {
            console.warn('[GoogleDrive] Failed to fetch user info', e);
        }
    }

    async login(): Promise<string> {
        // If we have a valid token (not expired), return it
        if (this.accessToken() && Date.now() < this.tokenExpiry()) {
            return this.accessToken()!;
        }

        // Try to refresh if we have a refresh token
        if (this.refreshToken()) {
            try {
                console.log('[GoogleDrive] Access token expired, attempting silent refresh...');
                const newToken = await this.refreshAccessToken();
                return newToken;
            } catch (error) {
                console.warn('[GoogleDrive] Silent refresh failed, falling back to interactive login:', error);
                // If refresh fails, clear the invalid refresh token and fall through to login
                this.clearTokens();
            }
        }

        if (this.isTauri) {
            return this.loginTauri();
        } else {
            return this.loginWeb();
        }
    }

    private clearTokens() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.accessToken.set(null);
        this.refreshToken.set(null);
        this.tokenExpiry.set(0);
        localStorage.removeItem('gdrive_access_token');
        localStorage.removeItem('gdrive_refresh_token');
        localStorage.removeItem('gdrive_token_expiry');
    }

    private async refreshAccessToken(): Promise<string> {
        const refreshToken = this.refreshToken();
        if (!refreshToken) throw new Error('No refresh token available');

        const creds = this.resolveOAuthCreds();
        const clientId = this.isTauri ? creds.clientIdTauri : creds.clientId;
        // Note: For Web, we usually need a client secret for refresh flow unless it's a specific client type
        // For Tauri, we might have a secret.
        const clientSecret = this.isTauri ? creds.clientSecretTauri : '';

        const body = new URLSearchParams({
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });

        if (clientSecret) {
            body.append('client_secret', clientSecret);
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
        const newAccessToken = data.access_token;
        const expiresIn = data.expires_in || 3599;

        console.log('[GoogleDrive] Token refreshed successfully');

        // Update state
        this.handleLoginSuccess(newAccessToken, expiresIn, data.refresh_token /* Might be returned sometimes */);

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

            // 3. Build URL
            const clientId = this.resolveOAuthCreds().clientIdTauri;
            const scope = 'https://www.googleapis.com/auth/drive.appdata email';
            // Add access_type=offline to get a refresh token
            // prompt=consent ensures we get a refresh token even if the user has authorized before
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                `response_type=code` +
                `&client_id=${clientId}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&scope=${encodeURIComponent(scope)}` +
                `&code_challenge=${challenge}` +
                `&code_challenge_method=S256` +
                `&access_type=offline` +
                `&prompt=consent`;

            console.log('[GoogleDrive] Opening Auth URL:', authUrl);

            // 4. Listen for Code (REGISTER BEFORE OPENING BROWSER)
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

                // 1. Standard Tauri v2 event
                listen<string>('oauth://url', (event) => {
                    console.log('[GoogleDrive] Received oauth://url:', event.payload);
                    cleanup();
                    resolve(event.payload);
                }).then(u => unlistenUrl = u);

                // 2. Custom/Legacy event names
                listen<string>('oauth://payload', (event) => {
                    console.log('[GoogleDrive] Received oauth://payload:', event.payload);
                    cleanup();
                    resolve(event.payload);
                }).then(u => unlistenPayload = u);

                listen<string>('oauth-response', (event) => {
                    console.log('[GoogleDrive] Received oauth-response:', event.payload);
                    cleanup();
                    resolve(event.payload);
                }).then(u => unlistenResponse = u);

                // Timeout after 5 minutes
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

    private async exchangeCodeForToken(code: string, verifier: string, redirectUri: string): Promise<{ token: string, expires_in: number, refresh_token?: string }> {
        const creds = this.resolveOAuthCreds();
        const body = new URLSearchParams({
            client_id: creds.clientIdTauri,
            grant_type: 'authorization_code',
            code: code,
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
                    // Fallback to interactive if silent failed
                    if (!forceInteractive && (resp.error === 'interaction_required' || resp.error === 'login_required')) {
                        console.warn('[GoogleDrive] Silent login failed, triggering interactive mode...');
                        this.loginWeb(true).then(resolve).catch(reject);
                        return;
                    }
                    reject(resp);
                } else {
                    this.handleLoginSuccess(resp.access_token, resp.expires_in);
                    resolve(resp.access_token);
                }
            };

            const savedEmail = localStorage.getItem('gdrive_user_email');
            const config: { prompt?: string, hint?: string } = {};

            if (!forceInteractive && savedEmail) {
                config.hint = savedEmail;
                config.prompt = ''; // Try silent
            } else {
                config.prompt = 'consent'; // Force interactive
            }

            console.log('[GoogleDrive] Requesting Web Token. Config:', config);
            this.tokenClient.requestAccessToken(config);
        });
    }

    private async getValidToken(): Promise<string> {
        // 1. If Token is valid, return it
        if (this.accessToken() && Date.now() < this.tokenExpiry()) {
            return this.accessToken()!;
        }

        // 2. Tauri: Use Refresh Token
        if (this.isTauri && this.refreshToken()) {
            try {
                console.log('[GoogleDrive] Tauri: Access token expired, refreshing...');
                return await this.refreshAccessToken();
            } catch (e) {
                console.warn('[GoogleDrive] Tauri refresh failed, falling back to login.', e);
                // Fallthrough to login handling
            }
        }

        // 3. Web or Failed Tauri Refresh -> Trigger Re-auth
        console.log('[GoogleDrive] Token expired or missing. Triggering re-auth...');

        if (this.isTauri) {
            // For Tauri, we always do the full flow if refresh failed (or no refresh token)
            return await this.loginTauri();
        } else {
            // Web: Try silent login first (handled by loginWeb default param)
            return await this.loginWeb();
        }
    }

    // ========== API Helper with Retry ========== //

    /**
     * Executes a Google Drive API operation with automatic token refresh on 401.
     */
    async execute<T>(operation: (token: string) => Promise<T>): Promise<T> {
        try {
            const token = await this.getValidToken();
            return await operation(token);
        } catch (error) {
            const e = error as { status?: number, message?: string };
            // Check if error is 401 (Unauthorized)
            if (e?.status === 401 || (e?.message && e.message.includes('401'))) {
                console.warn('[GoogleDrive] 401 Unauthorized encountered. Retry logic...');

                // If we have a refresh token, force a refresh
                if (this.refreshToken()) {
                    try {
                        const newToken = await this.refreshAccessToken();
                        return await operation(newToken);
                    } catch (refreshErr) {
                        console.warn('[GoogleDrive] Retry refresh failed', refreshErr);
                    }
                }

                // If no refresh token or refresh failed, clear and interactive login
                this.clearTokens();

                // Retry once with new login
                const newToken = await this.login();
                return await operation(newToken);
            }
            throw e;
        }
    }

    // --- AppData Folder Logic ---

    /**
     * Drive's `files.list` defaults to a page size of 100 and returns
     * `nextPageToken` when the result is truncated. Without explicit
     * pagination, callers silently miss everything past the first 100 —
     * which is correct enough for a small library but breaks restore
     * paths that resolve manifest entries against the listed result. We
     * page through with the maximum (1000) until the server stops
     * returning a `nextPageToken`.
     */
    private async listAllPaginated(
        query: string,
        fieldsForFile: string,
        token: string
    ): Promise<DriveFile[]> {
        const out: DriveFile[] = [];
        let pageToken: string | undefined;
        do {
            const params = new URLSearchParams({
                q: query,
                fields: `nextPageToken, files(${fieldsForFile})`,
                spaces: 'appDataFolder',
                pageSize: '1000'
            });
            if (pageToken) params.set('pageToken', pageToken);
            const res = await fetch(
                `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
                { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
            );
            if (!res.ok) throw { status: res.status, message: res.statusText };
            const data = await res.json() as { files?: DriveFile[]; nextPageToken?: string };
            if (data.files) out.push(...data.files);
            pageToken = data.nextPageToken;
        } while (pageToken);
        return out;
    }

    async listFiles(folderId = 'appDataFolder'): Promise<DriveFile[]> {
        return this.execute(async (token) => {
            return this.listAllPaginated(
                `'${folderId}' in parents and trashed = false`,
                'id,name,mimeType,parents,modifiedTime,size,md5Checksum,appProperties',
                token
            );
        });
    }

    /**
     * Lists subfolders within the App Data folder.
     */
    async listFolders(parentId = 'appDataFolder'): Promise<DriveFile[]> {
        return this.execute(async (token) => {
            return this.listAllPaginated(
                `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                'id,name,mimeType,parents,modifiedTime',
                token
            );
        });
    }

    /**
     * Creates a new folder.
     */
    async createFolder(parentId = 'appDataFolder', name: string): Promise<DriveFile> {
        return this.execute(async (token) => {
            const metadata = {
                name,
                parents: [parentId],
                mimeType: 'application/vnd.google-apps.folder'
            };

            const res = await fetch('https://www.googleapis.com/drive/v3/files', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(metadata)
            });

            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.json();
        });
    }

    async readFile(fileId: string): Promise<string> {
        return this.execute(async (token) => {
            const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: 'no-store'
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.text();
        });
    }

    async createFile(
        parentId = 'appDataFolder',
        name: string,
        content: string,
        appProperties?: Record<string, string>
    ): Promise<DriveFile> {
        return this.execute(async (token) => {
            const metadata: Record<string, unknown> = {
                name,
                parents: [parentId],
                mimeType: 'text/markdown'
            };
            if (appProperties) metadata['appProperties'] = appProperties;

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', new Blob([content], { type: 'text/plain' }));

            const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,parents,modifiedTime,size,md5Checksum,appProperties';
            const res = await fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: form
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.json() as DriveFile;
        });
    }

    /**
     * Updates the body of an existing file. To set or change the file's
     * `appProperties` (e.g. `last_active`), pass the full desired object —
     * Drive merges keys, so existing keys not mentioned are preserved, but
     * passing a key with `null` clears it.
     */
    async updateFile(
        fileId: string,
        content: string,
        appProperties?: Record<string, string>
    ): Promise<DriveFile> {
        return this.execute(async (token) => {
            // Body must be uploaded via uploadType=media OR multipart with metadata.
            // To attach metadata in the same call, use multipart.
            if (appProperties) {
                const form = new FormData();
                form.append('metadata', new Blob([JSON.stringify({ appProperties })], { type: 'application/json' }));
                form.append('file', new Blob([content], { type: 'text/plain' }));
                const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,name,mimeType,parents,modifiedTime,size,md5Checksum,appProperties`;
                const res = await fetch(url, {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${token}` },
                    body: form
                });
                if (!res.ok) throw { status: res.status, message: res.statusText };
                return await res.json() as DriveFile;
            }
            const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,mimeType,parents,modifiedTime,size,md5Checksum,appProperties`;
            const res = await fetch(url, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'text/plain'
                },
                body: content
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.json() as DriveFile;
        });
    }

    isAuthenticated() {
        return this.accessToken() !== null && Date.now() < this.tokenExpiry();
    }

    async deleteFile(fileId: string): Promise<void> {
        return this.execute(async (token) => {
            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
        });
    }

    /**
     * Server-side copy of a file into another folder. The `appProperties`
     * are copied implicitly by Drive — that's how snapshot objects keep
     * their original `last-active` / `deleted-at` markers without us
     * having to read+rewrite them.
     */
    async copyFile(fileId: string, newParentId: string, newName?: string): Promise<DriveFile> {
        return this.execute(async (token) => {
            const body: Record<string, unknown> = { parents: [newParentId] };
            if (newName !== undefined) body['name'] = newName;
            const url = `https://www.googleapis.com/drive/v3/files/${fileId}/copy?fields=id,name,mimeType,parents,modifiedTime,size,md5Checksum,appProperties`;
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.json() as DriveFile;
        });
    }

    /**
     * Deletes a folder and everything under it. Drive's DELETE on a folder
     * trashes the folder and its descendants in one call when permission
     * allows — but appDataFolder semantics don't reliably clean children,
     * so we walk explicitly.
     *
     * Children are deleted first (post-order) so an interrupted call
     * leaves the folder existing-but-emptier rather than a dangling
     * reference. Single-threaded for simplicity; snapshot delete is rare
     * and the tree is shallow (folder → 4 subfolders → leaf files).
     */
    async deleteFolderRecursive(folderId: string): Promise<void> {
        const subfolders = await this.listFolders(folderId);
        for (const sub of subfolders) {
            await this.deleteFolderRecursive(sub.id);
        }
        const files = await this.listFiles(folderId);
        for (const f of files) {
            // listFiles returns files AND folders; skip folders since we
            // already recursed into them above (and listFolders would have
            // included them).
            if (f.mimeType === 'application/vnd.google-apps.folder') continue;
            await this.deleteFile(f.id);
        }
        await this.deleteFile(folderId);
    }
}
