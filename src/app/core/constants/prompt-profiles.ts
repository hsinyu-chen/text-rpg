/** User profile ids must start with USER_PROFILE_ID_PREFIX to never collide with built-in ids. */
export interface PromptProfile {
    id: string;
    /** Built-in only; user profiles use `displayName`. */
    nameKey?: string;
    /** Built-in only. */
    descriptionKey?: string;
    isBuiltIn: boolean;
    /** Asset sub-dir under `assets/system_files/{lang}/`; null for the default profile and user profiles. */
    subDir: string | null;
    /** User-set; overrides `nameKey` when present. */
    displayName?: string;
    baseProfileId?: string;
    createdAt?: number;
    updatedAt?: number;
}

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

/** Built-in only — user profiles have no asset path. */
export function getProfileBasePath(langFolder: string, profileId: string): string {
    const profile = BUILT_IN_PROFILES.find(p => p.id === profileId);
    const base = `assets/system_files/${langFolder}`;
    return profile?.subDir ? `${base}/${profile.subDir}` : base;
}

/** Default profile uses the bare key for backward compatibility with pre-profile data. */
export function getProfileScopedKey(baseKey: string, profileId: string): string {
    return profileId === DEFAULT_PROFILE_ID ? baseKey : `${profileId}:${baseKey}`;
}

/** displayName → i18n via nameKey → id. */
export function getProfileDisplayName(profile: PromptProfile, uiStrings: Record<string, string>): string {
    if (profile.displayName) return profile.displayName;
    if (profile.nameKey) return uiStrings[profile.nameKey] ?? profile.nameKey;
    return profile.id;
}
