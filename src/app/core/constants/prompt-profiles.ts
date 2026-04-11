/**
 * Prompt Profile system - allows switching between multiple sets of system prompts.
 * Each profile represents a complete set of prompt files (system_prompt.md, injection_*.md, etc.)
 */

export interface PromptProfile {
    /** Unique identifier, e.g. 'cloud', 'local' */
    id: string;
    /** i18n key for display name (maps to uiStrings) */
    nameKey: string;
    /** i18n key for description */
    descriptionKey: string;
    /** Whether this profile ships with the app */
    isBuiltIn: boolean;
    /**
     * Sub-directory under `assets/system_files/{lang}/`.
     * null = root directory (default/cloud profile, backward compatible).
     * 'profiles/local' = `assets/system_files/{lang}/profiles/local/`
     */
    subDir: string | null;
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
 * Resolves the asset directory path for a given profile and language folder.
 * If the profile has a subDir, returns `assets/system_files/{langFolder}/{subDir}/`.
 * Otherwise, returns the root `assets/system_files/{langFolder}/`.
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
