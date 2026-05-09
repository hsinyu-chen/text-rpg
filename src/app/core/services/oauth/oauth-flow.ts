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
 * Strategy interface for the two Google OAuth flows TextRPG supports:
 * Web (GIS popup, no refresh token) and Tauri (PKCE + refresh token).
 *
 * Implementations own only the IdP interaction. Token persistence,
 * expiry bookkeeping, and refresh scheduling stay in
 * {@link GoogleOAuthService}.
 */
export interface OAuthFlow {
    login(): Promise<OAuthFlowResult>;

    /**
     * Attempt to obtain a fresh access token without user interaction.
     * - Web (GIS): silent popup attempt with saved email as hint.
     * - Tauri: refresh-token grant; throws if `refreshToken` is null.
     */
    refresh(refreshToken: string | null): Promise<OAuthFlowResult>;
}

/**
 * Scopes requested by both flows. `email` is needed for the user-info
 * hint that lets the Web flow attempt a silent re-login;
 * `drive.appdata` is the actual sync scope.
 */
export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.appdata email';
