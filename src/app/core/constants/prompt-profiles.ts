/**
 * Prompt Profile system - allows switching between multiple sets of system prompts.
 * Each profile represents a complete set of prompt files (system_prompt.md, injection_*.md, etc.)
 *
 * Built-in profiles ship with the app and are read-only (`isBuiltIn: true`).
 * User-defined profiles are clones stored entirely in IDB; their ids must start with
 * `USER_PROFILE_ID_PREFIX` so they can never collide with future built-in ids.
 */

export interface PromptProfile {
    /** Unique identifier. Built-in: 'cloud', 'local'. User: `user_<shortUuid>`. */
    id: string;
    /** i18n key for display name (built-in only; user profile uses `displayName`). */
    nameKey?: string;
    /** i18n key for description (built-in only). */
    descriptionKey?: string;
    /** Whether this profile ships with the app. */
    isBuiltIn: boolean;
    /**
     * Sub-directory under `assets/system_files/{lang}/`.
     * null = root directory (default/cloud profile, backward compatible).
     * 'profiles/local' = `assets/system_files/{lang}/profiles/local/`
     * User profiles set this to null — their content lives in IDB only.
     */
    subDir: string | null;
    /** User-set name shown in UI (overrides `nameKey` when present). */
    displayName?: string;
    /** Source profile id this was cloned from. */
    baseProfileId?: string;
    createdAt?: number;
    updatedAt?: number;
}

/** Reserved prefix for user-defined profile ids — never use for built-ins. */
export const USER_PROFILE_ID_PREFIX = 'user_';

export function isUserProfile(p: PromptProfile): boolean {
    return !p.isBuiltIn;
}

export const BUILT_IN_PROFILES: readonly PromptProfile[] = [
    {
        id: 'cloud',
        nameKey: 'PROFILE_CLOUD',
        descriptionKey: 'PROFILE_CLOUD_DESC',
        isBuiltIn: true,
        subDir: null
    },
    {
        id: 'local',
        nameKey: 'PROFILE_LOCAL',
        descriptionKey: 'PROFILE_LOCAL_DESC',
        isBuiltIn: true,
        subDir: 'profiles/local'
    }
] as const;

export const DEFAULT_PROFILE_ID = 'cloud';

/**
 * Resolves the asset directory path for a built-in profile and language folder.
 * User profiles have no asset path (their content is IDB-only) — callers must
 * not invoke this for non-built-in ids; the InjectionService routes user
 * profiles through `storage.getProfilePrompt` directly.
 */
export function getProfileBasePath(langFolder: string, profileId: string): string {
    const profile = BUILT_IN_PROFILES.find(p => p.id === profileId);
    const base = `assets/system_files/${langFolder}`;
    return profile?.subDir ? `${base}/${profile.subDir}` : base;
}

/**
 * Gets a profile-scoped localStorage/IDB key.
 * For the default 'cloud' profile, returns the key as-is (backward compatible).
 * For other profiles, prefixes the key with the profile ID.
 */
export function getProfileScopedKey(baseKey: string, profileId: string): string {
    return profileId === DEFAULT_PROFILE_ID ? baseKey : `${profileId}:${baseKey}`;
}
