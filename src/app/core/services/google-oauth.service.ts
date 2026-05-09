import { Injectable, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { KVStore } from './kv/kv-store';
import { OAuthTokenStore } from './oauth-token-store';
import { OAuthFlow, OAuthFlowResult } from './oauth/oauth-flow';
import { WebGisFlow } from './oauth/web-gis-flow';
import { TauriPkceFlow, TauriOAuthEndpointError } from './oauth/tauri-pkce-flow';

interface WindowWithTauri extends Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
}

declare const window: WindowWithTauri;

// BYO OAuth is web-only: there is no official Tauri distribution, so Tauri
// users always rebuild from source with credentials baked into environment.ts
// (Tauri PKCE additionally requires GCP "Desktop app" type + secret, which
// is awkward to enter through a runtime UI). Only the web client id has a
// runtime fallback.
const LS_OAUTH_CLIENT_ID = 'gdrive_oauth_client_id';

/**
 * Classifies a `flow.refresh()` failure so the orchestrator can decide
 * whether to clear cached tokens. Misclassifying transient errors as
 * fatal would log the user out on a network blip; misclassifying a
 * declined popup as transient would loop forever.
 */
type RefreshErrorClass = 'declined' | 'invalid' | 'transient';

function classifyRefreshError(error: unknown): RefreshErrorClass {
    if (!error || typeof error !== 'object') return 'transient';
    // GIS popup error: callback receives a TokenResponse with .error field.
    const gisError = (error as { error?: string }).error;
    if (gisError === 'popup_closed_by_user' || gisError === 'access_denied') {
        return 'declined';
    }
    // Tauri token endpoint error: structured errorCode field carries
    // Google's `error` value verbatim (e.g. `invalid_grant` when the saved
    // refresh token is no longer valid).
    if (error instanceof TauriOAuthEndpointError && error.errorCode === 'invalid_grant') {
        return 'invalid';
    }
    return 'transient';
}

/**
 * Owns the Google OAuth lifecycle: credential resolution (env vs runtime
 * config), token state (access + refresh + expiry), refresh scheduling,
 * and the `getValidToken` accessor that Drive REST callers use to
 * authenticate each request.
 *
 * The IdP-facing protocol details — GIS popup vs Tauri PKCE — live in
 * {@link WebGisFlow} and {@link TauriPkceFlow}; this service picks one
 * based on `isTauri` at construction. Token persistence is delegated to
 * {@link OAuthTokenStore}.
 *
 * Drive REST itself lives in `GoogleDriveService`, which depends on this
 * service for token acquisition and the 401-retry seam.
 */
@Injectable({ providedIn: 'root' })
export class GoogleOAuthService {
    private readonly kv = inject(KVStore);
    private readonly tokenStore = inject(OAuthTokenStore);
    private readonly webFlow = inject(WebGisFlow);
    private readonly tauriFlow = inject(TauriPkceFlow);

    private accessToken = signal<string | null>(null);
    private refreshToken = signal<string | null>(null);
    private tokenExpiry = signal<number>(0);

    private isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    // Memoizes an in-flight token acquisition so concurrent callers don't
    // each spawn their own flow.login() / flow.refresh() — Web flow's
    // singleton GIS callback would have one of them hang forever, and
    // Tauri would open multiple browser tabs.
    private inFlightAuth: Promise<string> | null = null;

    private get flow(): OAuthFlow {
        return this.isTauri ? this.tauriFlow : this.webFlow;
    }

    constructor() {
        const saved = this.tokenStore.load();
        if (saved) {
            this.accessToken.set(saved.accessToken);
            this.tokenExpiry.set(saved.expiry);
            if (saved.refreshToken) {
                this.refreshToken.set(saved.refreshToken);
                console.log('[GoogleOAuth] Restored refresh token from storage');
            }
        }

        console.log('[GoogleOAuth] Service initialized. Token expiry:', new Date(this.tokenExpiry()).toLocaleString());
        if (!this.isTauri && this.isConfigured) {
            this.webFlow.init(this.getOAuthClientIdSnapshot());
        }
    }

    get isConfigured(): boolean {
        return this.getOAuthClientIdSnapshot().length > 0;
    }

    /** Whether the running build has the web client id slot empty and
     *  therefore exposes the BYO OAuth input field in Settings. Web-only:
     *  Tauri users always rebuild from source. */
    get isUserConfigurable(): boolean {
        return !environment.gcpOauthAppId && !this.isTauri;
    }

    /**
     * Currently-effective web client id. Falls back to a user-supplied
     * runtime value when `environment.gcpOauthAppId` is empty (BYO OAuth
     * in web builds). Tauri-specific creds are read from environment only
     * by {@link TauriPkceFlow} — see project memory: there is no official
     * Tauri build, so Tauri users always rebuild with env baked in.
     */
    getOAuthClientIdSnapshot(): string {
        return environment.gcpOauthAppId || this.kv.get(LS_OAUTH_CLIENT_ID) || '';
    }

    isAuthenticated(): boolean {
        return this.accessToken() !== null && Date.now() < this.tokenExpiry();
    }

    /**
     * Persists the user-supplied web Client ID and rebuilds the token
     * client. Old tokens are cleared because they were issued by the
     * previous client id and refreshing them would fail — better to force
     * a fresh interactive login on the next sync.
     *
     * Clearing creds (empty input) tears down the GIS token client so
     * subsequent calls don't accidentally reach Google with the previous
     * client id.
     */
    saveOAuthClientId(clientId: string): void {
        const trimmed = clientId.trim();
        if (trimmed) this.kv.set(LS_OAUTH_CLIENT_ID, trimmed);
        else this.kv.remove(LS_OAUTH_CLIENT_ID);
        this.clearTokens();
        if (!this.isConfigured) {
            this.webFlow.teardown();
            return;
        }
        this.webFlow.init(this.getOAuthClientIdSnapshot());
    }

    private applyResult(result: OAuthFlowResult): string {
        this.accessToken.set(result.accessToken);

        // Set expiry slightly before actual expiry (5 min buffer for
        // isAuthenticated()). Floor at 10s so very short test tokens
        // (expiresInSeconds < 300) still register as briefly authenticated
        // instead of computing a past timestamp and looping refresh.
        const expiryBufferSeconds = 300;
        const effectiveSeconds = Math.max(10, result.expiresInSeconds - expiryBufferSeconds);
        const expiry = Date.now() + effectiveSeconds * 1000;
        this.tokenExpiry.set(expiry);

        if (result.refreshToken) {
            this.refreshToken.set(result.refreshToken);
            console.log('[GoogleOAuth] Refresh token saved');
        }

        this.tokenStore.save({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken ?? null,
            expiry,
        });

        if (!this.tokenStore.getUserEmail()) {
            void this.fetchAndSaveUserEmail(result.accessToken);
        }

        this.scheduleAutoRefresh(result.expiresInSeconds);
        return result.accessToken;
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
        // Route through the same acquireToken path user requests use, so a
        // concurrent ensureValidToken caller joining inFlightAuth gets the
        // full refresh-or-login behavior — not a refresh-only closure that
        // would surface invalid_grant as a fatal failure to the caller.
        // Trade-off: invalid_grant on the timer-driven path may surface an
        // interactive popup while the user is idle, but that is the correct
        // signal — the session is genuinely dead and needs re-auth.
        try {
            await this.memoizeAuth(() => this.acquireToken());
            console.log('[GoogleOAuth] Proactive refresh successful');
        } catch (e) {
            if (classifyRefreshError(e) === 'declined') this.clearTokens();
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
                    this.tokenStore.setUserEmail(data.email);
                    console.log('[GoogleOAuth] User email saved for hint:', data.email);
                }
            }
        } catch (e) {
            console.warn('[GoogleOAuth] Failed to fetch user info', e);
        }
    }

    /**
     * Coalesce concurrent auth attempts onto a single in-flight promise.
     * Without this, two parallel Drive 401s (or any concurrent
     * `getValidToken` callers) each spawn their own `flow.login()` /
     * `flow.refresh()` — which Web GIS cannot serve (singleton callback)
     * and Tauri shouldn't (multiple browser tabs).
     */
    private memoizeAuth(operation: () => Promise<string>): Promise<string> {
        if (this.inFlightAuth) return this.inFlightAuth;
        const p = operation().finally(() => {
            if (this.inFlightAuth === p) this.inFlightAuth = null;
        });
        this.inFlightAuth = p;
        return p;
    }

    /**
     * Shared implementation backing {@link GoogleOAuthService.login}
     * (user-initiated sign-in) and {@link GoogleOAuthService.getValidToken}
     * (per-request token reads): cached if still fresh, refreshed if a
     * refresh token is available, otherwise interactive login.
     */
    private ensureValidToken(): Promise<string> {
        if (this.accessToken() && Date.now() < this.tokenExpiry()) {
            return Promise.resolve(this.accessToken()!);
        }
        return this.memoizeAuth(() => this.acquireToken());
    }

    private async acquireToken(): Promise<string> {
        // Web flow: refresh() escalates inside (silent → interactive popup),
        // so a throw means either the user rejected or something transient
        // broke. Clear only on explicit decline; transient errors (network
        // blip, GIS script not loaded yet) preserve state so the next
        // attempt can succeed against the cached cookies.
        if (this.flow.refreshIncludesInteractive) {
            try {
                return this.applyResult(await this.flow.refresh(this.refreshToken()));
            } catch (e) {
                if (classifyRefreshError(e) === 'declined') this.clearTokens();
                throw e;
            }
        }
        // Tauri: refresh-token grant first when we have one. Transient errors
        // (offline, 5xx) preserve the refresh token for retry; invalid_grant
        // and "no token" both fall through to a fresh interactive PKCE round.
        if (this.refreshToken()) {
            try {
                console.log('[GoogleOAuth] Access token expired, refreshing...');
                return this.applyResult(await this.flow.refresh(this.refreshToken()));
            } catch (e) {
                if (classifyRefreshError(e) === 'transient') {
                    console.warn('[GoogleOAuth] Transient refresh error, preserving state for retry:', e);
                    throw e;
                }
                console.warn('[GoogleOAuth] Refresh token invalid, falling back to interactive login:', e);
            }
        }
        // Clear any stale refresh token before interactive login so we don't
        // try to use a known-bad one on the next ensureValidToken cycle.
        this.clearTokens();
        return this.applyResult(await this.flow.login());
    }

    /** User-initiated sign-in (login button). Returns the access token. */
    login(): Promise<string> {
        return this.ensureValidToken();
    }

    /**
     * Returns a non-expired access token, refreshing or re-authenticating
     * as needed. Drive REST callers (`GoogleDriveService.execute`) wrap
     * this with 401-retry; clients that just want a token for a one-off
     * fetch can call this directly.
     */
    getValidToken(): Promise<string> {
        return this.ensureValidToken();
    }

    /**
     * 401 retry primitive used by Drive REST: bypasses the cached-token
     * check (the cached one is what just failed), tries refresh, then
     * falls through to interactive login. Caller re-runs the original
     * request with the returned token.
     *
     * Joins any in-flight `ensureValidToken` so concurrent 401s share a
     * single re-auth round.
     */
    forceReauthAfter401(): Promise<string> {
        console.warn('[GoogleOAuth] 401 Unauthorized encountered. Retry logic...');
        // If the cached token is still time-valid AND non-null, a concurrent
        // acquire already wrote a fresh one — the 401 we saw was the
        // caller's stale local copy. Return the new token instead of wasting
        // another IdP round.
        if (this.accessToken() && Date.now() < this.tokenExpiry()) {
            return Promise.resolve(this.accessToken()!);
        }
        // Mark the cached access token dead before joining the in-flight
        // check, so concurrent getValidToken callers see "expired" and queue
        // onto our reauth instead of returning the now-revoked cached value
        // (whose tokenExpiry timestamp is still in the future). Refresh
        // token is intentionally left intact — only access is known dead.
        this.accessToken.set(null);
        this.tokenExpiry.set(0);
        return this.memoizeAuth(() => this.acquireToken());
    }

    private clearTokens(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.accessToken.set(null);
        this.refreshToken.set(null);
        this.tokenExpiry.set(0);
        this.tokenStore.clear();
    }

    /** True iff this 401-shaped error should trigger the re-auth-and-retry seam. */
    static isUnauthorized(err: unknown): boolean {
        const e = err as { status?: number; message?: string };
        return e?.status === 401 || (!!e?.message && e.message.includes('401'));
    }
}
