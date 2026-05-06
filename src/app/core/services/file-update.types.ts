export interface FileUpdate {
    filePath: string;
    targetContent?: string;
    replacementContent?: string;
    context?: string;
    line?: number;
    // Metadata for UI
    beforeLines?: string[];
    afterLines?: string[];
    matchIndex?: number;
    alreadyExists?: boolean;
    label?: string;
}
