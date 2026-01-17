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

    get isConfigured(): boolean {
        return !!environment.gcpOauthAppId && environment.gcpOauthAppId.length > 0;
    }

    private loadScripts() {
        // Load Google Identity Services (GIS)
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => this.initClient();
        document.body.appendChild(script);
    }

    private initClient() {
        if (!google) return;

        this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: environment.gcpOauthAppId,
            scope: 'https://www.googleapis.com/auth/drive.appdata email',
            callback: (tokenResponse: TokenResponse) => {
                if (tokenResponse && tokenResponse.access_token) {
                    this.handleLoginSuccess(tokenResponse.access_token, tokenResponse.expires_in);
                }
            },
        });
    }

    hasAuthError = signal(false);

    private handleLoginSuccess(token: string, expiresInSeconds = 3599, refreshToken?: string) {
        this.accessToken.set(token);
        this.hasAuthError.set(false); // Clear any previous error
        // Set expiry to slightly before actual expiry (e.g., 5 min buffer)
        const expiry = Date.now() + (expiresInSeconds - 300) * 1000;
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
    }

    reportAuthError() {
        this.hasAuthError.set(true);
    }

    private async fetchAndSaveUserEmail(token: string) {
        try {
            const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${token}` }
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

        const clientId = this.isTauri ? environment.gcpOauthAppId_Tauri : environment.gcpOauthAppId;
        // Note: For Web, we usually need a client secret for refresh flow unless it's a specific client type
        // For Tauri, we might have a secret.
        const clientSecret = this.isTauri ? environment.gcpOauthClientSecret_Tauri : '';

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
            const clientId = environment.gcpOauthAppId_Tauri;
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
        const clientId = environment.gcpOauthAppId_Tauri;
        const body = new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
        });

        // Some Google Client IDs (like Web Applications) require a secret even with PKCE
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

    async listFiles(folderId = 'appDataFolder'): Promise<DriveFile[]> {
        return this.execute(async (token) => {
            const query = `'${folderId}' in parents and trashed = false`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,parents,modifiedTime)&spaces=appDataFolder`;

            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (!res.ok) throw { status: res.status, message: res.statusText };

            const data = await res.json();
            return data.files || [];
        });
    }

    /**
     * Lists subfolders within the App Data folder.
     */
    async listFolders(parentId = 'appDataFolder'): Promise<DriveFile[]> {
        return this.execute(async (token) => {
            const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,parents,modifiedTime)&spaces=appDataFolder`;

            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (!res.ok) throw { status: res.status, message: res.statusText };

            const data = await res.json();
            return data.files || [];
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
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.text();
        });
    }

    async createFile(parentId = 'appDataFolder', name: string, content: string): Promise<void> {
        return this.execute(async (token) => {
            const metadata = {
                name,
                parents: [parentId],
                mimeType: 'text/markdown'
            };

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', new Blob([content], { type: 'text/plain' }));

            const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
            const res = await fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: form
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
        });
    }

    async updateFile(fileId: string, content: string): Promise<void> {
        return this.execute(async (token) => {
            const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
            const res = await fetch(url, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'text/plain'
                },
                body: content
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
        });
    }

    isAuthenticated() {
        return this.accessToken() !== null && Date.now() < this.tokenExpiry();
    }

    // ========== Session Saves ==========

    // ========== Session Saves ==========

    private savesFolderCache = new Map<string, string>(); // parentId -> savesFolderId

    /**
     * Ensures the 'saves' folder exists within the specified parent folder and returns its ID.
     */
    private async ensureSavesFolder(parentId = 'appDataFolder'): Promise<string> {
        const cached = this.savesFolderCache.get(parentId);
        if (cached) return cached;

        return this.execute(async (token) => {
            const query = `name = 'saves' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
            const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&spaces=appDataFolder`;

            const searchRes = await fetch(searchUrl, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!searchRes.ok) throw { status: searchRes.status, message: searchRes.statusText };
            const searchData = await searchRes.json();

            if (searchData.files && searchData.files.length > 0) {
                const id = searchData.files[0].id;
                this.savesFolderCache.set(parentId, id);
                return id;
            }

            // Create the folder
            const metadata = {
                name: 'saves',
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId]
            };

            const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(metadata)
            });
            if (!createRes.ok) throw { status: createRes.status, message: createRes.statusText };
            const createData = await createRes.json();
            this.savesFolderCache.set(parentId, createData.id);
            return createData.id;
        });
    }

    /**
     * Lists all session save files in the 'saves' folder of a specific parent.
     */
    async listSaves(parentId = 'appDataFolder'): Promise<DriveFile[]> {
        const folderId = await this.ensureSavesFolder(parentId);
        return this.execute(async (token) => {
            const query = `'${folderId}' in parents and trashed = false`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime)&spaces=appDataFolder`;

            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            const data = await res.json();
            return data.files || [];
        });
    }

    /**
     * Uploads a session save to the 'saves' folder of a specific parent.
     */
    async uploadSave(save: { id: string }, parentId = 'appDataFolder'): Promise<void> {
        const folderId = await this.ensureSavesFolder(parentId);
        const fileName = `${save.id}.json`;
        const content = JSON.stringify(save);

        const existingFiles = await this.listSaves(parentId);
        const existing = existingFiles.find(f => f.name === fileName);

        if (existing) {
            // Update
            return this.execute(async (token) => {
                const url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`;
                const res = await fetch(url, {
                    method: 'PATCH',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: content
                });
                if (!res.ok) throw { status: res.status, message: res.statusText };
            });
        } else {
            // Create
            return this.execute(async (token) => {
                const metadata = {
                    name: fileName,
                    parents: [folderId],
                    mimeType: 'application/json'
                };
                const form = new FormData();
                form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                form.append('file', new Blob([content], { type: 'application/json' }));

                const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                    body: form
                });
                if (!res.ok) throw { status: res.status, message: res.statusText };
            });
        }
    }

    /**
     * Downloads a session save by file ID.
     */
    async downloadSave<T>(fileId: string): Promise<T> {
        return this.execute(async (token) => {
            const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            const text = await res.text();
            return JSON.parse(text) as T;
        });
    }

    /**
     * Deletes a session save by file ID.
     */
    async deleteSaveFromDrive(fileId: string): Promise<void> {
        return this.execute(async (token) => {
            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
        });
    }
}
