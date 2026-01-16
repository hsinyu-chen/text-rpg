import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { GameStateService } from './game-state.service';
import { getUIStrings } from '../constants/engine-protocol';

/**
 * Fields available for post-processing.
 * Only includes user-editable text fields.
 */
export interface PostProcessFields {
    story: string;
    summary: string;
    character_log: string[];
    inventory_log: string[];
    quest_log: string[];
    world_log: string[];
}

/**
 * Validation result for post-processing script.
 */
export interface PostProcessValidation {
    valid: boolean;
    error?: string;
}

/** Mock data for script validation */
const MOCK_DATA: PostProcessFields = {
    story: 'Test story content.',
    summary: 'Test summary.',
    character_log: ['[New] Test Character'],
    inventory_log: ['[Add]: Test Item / 1'],
    quest_log: ['[New]: Test Quest'],
    world_log: ['[Discovery]: Test Location']
};

/**
 * Service responsible for executing user-defined post-processing scripts.
 * Provides safe script execution with error handling.
 */
@Injectable({
    providedIn: 'root'
})
export class PostProcessorService {
    private state = inject(GameStateService);
    private snackBar = inject(MatSnackBar);

    /**
     * Validates a post-processing script with mock data.
     * @param script The script to validate
     * @returns Validation result with success/failure and error message
     */
    validate(script: string): PostProcessValidation {
        if (!script?.trim()) {
            return { valid: true };
        }

        try {
            const fn = new Function('response', script) as (response: PostProcessFields) => PostProcessFields;
            const result = fn({ ...MOCK_DATA });

            // Validate result structure
            if (!result || typeof result !== 'object') {
                return { valid: false, error: 'Script must return an object' };
            }

            // Check required fields exist
            const requiredKeys: (keyof PostProcessFields)[] = [
                'story', 'summary', 'character_log', 'inventory_log', 'quest_log', 'world_log'
            ];
            for (const key of requiredKeys) {
                if (!(key in result)) {
                    return { valid: false, error: `Missing required field: ${key}` };
                }
            }

            return { valid: true };
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return { valid: false, error: errorMsg };
        }
    }

    /**
     * Executes user post-processing script on response fields.
     * @param fields The editable text fields from AI response
     * @returns Processed fields, or original fields if script fails
     */
    process(fields: PostProcessFields): PostProcessFields {
        const script = this.state.postProcessScript();
        if (!script?.trim()) return fields;

        try {
            const fn = new Function('response', script) as (response: PostProcessFields) => PostProcessFields;
            const result = fn(fields);

            if (!result || typeof result !== 'object') {
                throw new Error('Script must return an object');
            }

            return result;
        } catch (err) {
            const lang = this.state.config()?.outputLanguage || 'default';
            const ui = getUIStrings(lang);
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.snackBar.open(
                ui.POST_PROCESS_ERROR.replace('{error}', errorMsg),
                ui.CLOSE,
                { duration: 5000, panelClass: 'error-snackbar' }
            );
            return fields;
        }
    }
}
