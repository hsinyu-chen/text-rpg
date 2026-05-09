import { Injectable, inject } from '@angular/core';
import { KVStore } from './kv/kv-store';

const LS_ACCESS_TOKEN = 'gdrive_access_token';
const LS_REFRESH_TOKEN = 'gdrive_refresh_token';
const LS_TOKEN_EXPIRY = 'gdrive_token_expiry';
const LS_USER_EMAIL = 'gdrive_user_email';

export interface TokenBundle {
    accessToken: string;
    refreshToken: string | null;
    expiry: number;
}

/**
 * Persists Google OAuth tokens. Owns the KV key naming so flow
 * implementations and {@link GoogleOAuthService} never reach into
 * `KVStore` for token state directly.
 *
 * User email is co-located here because it serves as the GIS silent
 * re-login `hint` — its lifecycle is auth-bound, not config-bound. It
 * is intentionally NOT cleared on `clear()`: keeping the email after
 * logout lets a subsequent sign-in silent-relogin as the same
 * identity.
 */
@Injectable({ providedIn: 'root' })
export class OAuthTokenStore {
    private kv = inject(KVStore);

    load(): TokenBundle | null {
        const accessToken = this.kv.get(LS_ACCESS_TOKEN);
        if (!accessToken) return null;
        const expiryRaw = this.kv.get(LS_TOKEN_EXPIRY);
        return {
            accessToken,
            refreshToken: this.kv.get(LS_REFRESH_TOKEN),
            expiry: expiryRaw ? parseInt(expiryRaw, 10) : 0,
        };
    }

    save(bundle: TokenBundle): void {
        this.kv.set(LS_ACCESS_TOKEN, bundle.accessToken);
        this.kv.set(LS_TOKEN_EXPIRY, bundle.expiry.toString());
        // Refresh-token absence does not clear an existing one: GIS popup
        // re-auths return without refresh_token and we want to keep the
        // previously-saved one for the Tauri refresh path.
        if (bundle.refreshToken) {
            this.kv.set(LS_REFRESH_TOKEN, bundle.refreshToken);
        }
    }

    clear(): void {
        this.kv.remove(LS_ACCESS_TOKEN);
        this.kv.remove(LS_REFRESH_TOKEN);
        this.kv.remove(LS_TOKEN_EXPIRY);
    }

    getUserEmail(): string | null {
        return this.kv.get(LS_USER_EMAIL);
    }

    setUserEmail(email: string): void {
        this.kv.set(LS_USER_EMAIL, email);
    }
}
