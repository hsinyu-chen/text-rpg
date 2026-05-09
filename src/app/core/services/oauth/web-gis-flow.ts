import { Injectable, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { OAuthTokenStore } from '../oauth-token-store';
import { OAuthFlow, OAuthFlowResult, OAUTH_SCOPE } from './oauth-flow';

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

/**
 * Google Identity Services (GIS) popup flow for browser builds. Owns
 * the GIS script <script> element and the token client lifecycle.
 *
 * GIS popups never issue a refresh token, so {@link refresh} is
 * implemented as a silent re-login attempt with the saved email as
 * `hint` — falls back to the regular interactive popup if Google
 * declines silent.
 */
@Injectable({ providedIn: 'root' })
export class WebGisFlow implements OAuthFlow {
    readonly refreshIncludesInteractive = true;

    private readonly doc = inject(DOCUMENT);
    private readonly tokenStore = inject(OAuthTokenStore);

    private tokenClient: TokenClient | null = null;
    private currentClientId = '';

    // Tracks whether the GIS script has been requested so we don't append a
    // second <script> when init() runs again (e.g. user pasted creds after
    // boot in a build whose environment was empty).
    private gisScriptLoading = false;
    private gisScript: HTMLScriptElement | null = null;

    /**
     * Loads the GIS script (if not already) and (re)initialises the token
     * client with the given client id. Idempotent: safe to call repeatedly;
     * `initTokenClient` overwrites the previous instance.
     */
    init(clientId: string): void {
        this.currentClientId = clientId;
        if (typeof google === 'undefined') {
            this.loadScripts();
            return;
        }
        this.initTokenClient();
    }

    /** Drops the token client; subsequent {@link login}/{@link refresh}
     *  calls will fail until {@link init} is called again. */
    teardown(): void {
        this.tokenClient = null;
        this.currentClientId = '';
    }

    login(): Promise<OAuthFlowResult> {
        return this.requestToken(true);
    }

    refresh(): Promise<OAuthFlowResult> {
        return this.requestToken(false);
    }

    private loadScripts(): void {
        if (this.gisScriptLoading) {
            // Script already requested; if it's done loading, just (re)init.
            if (typeof google !== 'undefined') this.initTokenClient();
            return;
        }
        this.gisScriptLoading = true;
        const script = this.doc.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => this.initTokenClient();
        // If the script fails to load (ad blocker, offline, corp network
        // blocking accounts.google.com), reset the flag and detach the
        // failed tag so a later init() can append a fresh one instead of
        // silently no-oping or stacking dead <script> nodes.
        script.onerror = () => {
            console.warn('[WebGisFlow] Failed to load GIS script (network blocked?)');
            this.gisScriptLoading = false;
            script.remove();
            if (this.gisScript === script) this.gisScript = null;
        };
        this.gisScript = script;
        this.doc.body.appendChild(script);
    }

    private initTokenClient(): void {
        if (typeof google === 'undefined') return;
        if (!this.currentClientId) return;

        this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: this.currentClientId,
            scope: OAUTH_SCOPE,
            // Per-call callback set in requestToken; this default exists
            // only so initTokenClient's required field is satisfied.
            callback: () => { /* overridden per-call */ },
        });
    }

    private requestToken(forceInteractive: boolean): Promise<OAuthFlowResult> {
        return new Promise((resolve, reject) => {
            if (!this.tokenClient) {
                this.initTokenClient();
                if (!this.tokenClient) {
                    reject(new Error('Google Sign-In not initialized'));
                    return;
                }
            }

            this.tokenClient.callback = (resp: TokenResponse) => {
                if (resp.error) {
                    if (!forceInteractive && (resp.error === 'interaction_required' || resp.error === 'login_required')) {
                        console.warn('[WebGisFlow] Silent login failed, triggering interactive mode...');
                        this.requestToken(true).then(resolve).catch(reject);
                        return;
                    }
                    reject(resp);
                } else {
                    resolve({
                        accessToken: resp.access_token,
                        expiresInSeconds: resp.expires_in,
                    });
                }
            };

            const savedEmail = this.tokenStore.getUserEmail();
            const config: { prompt?: string; hint?: string } = {};

            if (!forceInteractive && savedEmail) {
                config.hint = savedEmail;
                config.prompt = '';
            } else {
                config.prompt = 'consent';
            }

            console.log('[WebGisFlow] Requesting Web Token. Config:', config);
            this.tokenClient.requestAccessToken(config);
        });
    }
}
