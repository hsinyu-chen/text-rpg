export interface FileUpdate {
    filePath: string;
    targetContent?: string;
    replacementContent?: string;
    context?: string[];
    line?: number;
    // Metadata for UI
    beforeLines?: string[];
    afterLines?: string[];
    matchIndex?: number;
    alreadyExists?: boolean;
    label?: string;
}

/**
 * Outcome of validating one hunk against a source. `exists` reports whether the
 * source itself was available (false only when a file read fails — the pure,
 * content-supplied path always sees a source so reports true). `failReason` is
 * set only when `exists && !matched`.
 */
export interface ValidationResult {
    exists: boolean;
    matched: boolean;
    alreadyExists?: boolean;
    beforeLines?: string[];
    afterLines?: string[];
    matchIndex?: number;
    failReason?: 'target_not_found' | 'context_mismatch';
}
