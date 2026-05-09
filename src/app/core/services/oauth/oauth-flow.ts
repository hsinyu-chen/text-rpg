/**
 * Result of a Google OAuth login or refresh — the protocol-shape returned
 * by IdP interactions, before the service buffers the expiry and persists
 * via {@link OAuthTokenStore}.
 *
 * `expiresInSeconds` is the raw value from Google (typically 3599); the
 * service is responsible for subtracting the safety buffer when computing
 * the persisted expiry timestamp.
 */
export interface OAuthFlowResult {
    accessToken: string;
    expiresInSeconds: number;
    refreshToken?: string;
}

/**
 * Classification of a `flow.refresh()` failure that decides whether
 * the orchestrator should clear cached tokens. Each flow knows its
 * own error shapes and maps them via {@link OAuthFlow.classifyError}.
 *
 * - `declined`: user explicitly rejected (closed popup, denied consent).
 *   State should be cleared so the UI reflects logged-out.
 * - `invalid`: Google said the saved refresh token is bad. Token must
 *   be cleared; on Tauri the orchestrator may try interactive PKCE next.
 * - `transient`: network failure, 5xx, GIS script not loaded yet.
 *   State should be preserved so a later retry can succeed.
 */
export type RefreshErrorClass = 'declined' | 'invalid' | 'transient';

/**
 * Strategy interface for the two Google OAuth flows TextRPG supports:
 * Web (GIS popup, no refresh token) and Tauri (PKCE + refresh token).
 *
 * Implementations own only the IdP interaction and the mapping from
 * their own error shapes to {@link RefreshErrorClass}. Token
 * persistence, expiry bookkeeping, and refresh scheduling stay in
 * {@link GoogleOAuthService}.
 */
export interface OAuthFlow {
    login(): Promise<OAuthFlowResult>;

    /**
     * Attempt to obtain a fresh access token, preferring no user
     * interaction. Behaviour and contract differ per flow:
     *
     * - Tauri: POSTs the refresh-token grant. Throws if `refreshToken`
     *   is null. Service falls through to {@link login} on failure.
     * - Web (GIS): runs a silent popup attempt with saved email as hint
     *   and ESCALATES to an interactive popup if Google declines silent
     *   ({@link refreshIncludesInteractive} = true). A throw here means
     *   the user actively rejected (closed popup, denied consent), so
     *   the service must NOT call {@link login} again.
     */
    refresh(refreshToken: string | null): Promise<OAuthFlowResult>;

    /**
     * True iff `refresh()` may itself prompt the user (Web GIS does;
     * Tauri does not). The service uses this to decide whether
     * `refresh()` failure should fall through to a fresh `login()`
     * attempt — re-prompting after the user already declined would
     * double-popup.
     */
    readonly refreshIncludesInteractive: boolean;

    /**
     * Classifies an error thrown by {@link login} or {@link refresh}
     * into a category the orchestrator can act on without inspecting
     * IdP-specific error shapes. Unknown errors map to `transient` so
     * the safe default (preserve state, retry later) wins.
     */
    classifyError(error: unknown): RefreshErrorClass;
}

/**
 * Scopes requested by both flows. `email` is needed for the user-info
 * hint that lets the Web flow attempt a silent re-login;
 * `drive.appdata` is the actual sync scope.
 */
export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.appdata email';
