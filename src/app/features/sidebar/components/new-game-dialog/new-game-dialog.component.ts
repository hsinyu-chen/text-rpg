import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService } from '../../../../core/services/game-state.service';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { getUIStrings } from '../../../../core/constants/engine-protocol';
import { Scenario } from '../../../../core/models/types';
import { getLocale } from '../../../../core/constants/locales';
@Component({
    selector: 'app-new-game-dialog',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatInputModule,
        MatIconModule,
        MatSelectModule,
        MatDialogModule,
        MatProgressSpinnerModule,
        MatSnackBarModule,
        MatTooltipModule
    ],
    templateUrl: './new-game-dialog.component.html',
    styleUrl: './new-game-dialog.component.scss'
})
export class NewGameDialogComponent {
    private engine = inject(GameEngineService);
    private state = inject(GameStateService);
    private dialogRef = inject(MatDialogRef<NewGameDialogComponent>);
    private http = inject(HttpClient);
    private snackBar = inject(MatSnackBar);

    isLoading = signal(false);

    ui = computed(() => {
        const lang = this.state.config()?.outputLanguage || 'default';
        return getUIStrings(lang);
    });
    scenarios = signal<Scenario[]>([]);
    selectedScenarioId = signal<string>('');

    profile = {
        name: signal(''),
        faction: signal(''),
        background: signal(''),
        interests: signal(''),
        appearance: signal(''),
        coreValues: signal('')
    };

    labels = computed(() => {
        const lang = this.state.config()?.outputLanguage || 'default';
        const ui = getUIStrings(lang);
        return {
            name: ui.USER_NAME,
            faction: ui.USER_FACTION,
            background: ui.USER_BACKGROUND,
            interests: ui.USER_INTERESTS,
            appearance: ui.USER_APPEARANCE,
            coreValues: ui.USER_CORE_VALUES
        };
    });

    alignments = computed(() => {
        const lang = this.state.config()?.outputLanguage || 'default';
        const ui = getUIStrings(lang);
        const alignments = ui.ALIGNMENTS || {};

        return [
            [
                { id: 'Lawful Good', label: alignments['Lawful Good'] || 'Lawful Good' },
                { id: 'Neutral Good', label: alignments['Neutral Good'] || 'Neutral Good' },
                { id: 'Chaotic Good', label: alignments['Chaotic Good'] || 'Chaotic Good' }
            ],
            [
                { id: 'Lawful Neutral', label: alignments['Lawful Neutral'] || 'Lawful Neutral' },
                { id: 'True Neutral', label: alignments['True Neutral'] || 'True Neutral' },
                { id: 'Chaotic Neutral', label: alignments['Chaotic Neutral'] || 'Chaotic Neutral' }
            ],
            [
                { id: 'Lawful Evil', label: alignments['Lawful Evil'] || 'Lawful Evil' },
                { id: 'Neutral Evil', label: alignments['Neutral Evil'] || 'Neutral Evil' },
                { id: 'Chaotic Evil', label: alignments['Chaotic Evil'] || 'Chaotic Evil' }
            ]
        ];
    });

    displayScenarios = computed(() => {
        const lang = this.state.config()?.outputLanguage || 'default';
        const targetLocaleId = getLocale(lang).id;

        return this.scenarios().filter(s => s.lang === targetLocaleId);
    });

    constructor() {
        this.init();
    }

    async init() {
        this.isLoading.set(true);
        try {
            const scenarios = await firstValueFrom(this.http.get<Scenario[]>('assets/system_files/scenario/scenarios.json'));
            this.scenarios.set(scenarios);
            const filtered = this.displayScenarios();
            if (filtered && filtered.length > 0) {
                this.selectedScenarioId.set(filtered[0].id);
                await this.loadDefaultValues(filtered[0]);
            }
        } catch (e) {
            console.error('Failed to load scenarios', e);
        } finally {
            this.isLoading.set(false);
        }
    }

    async onScenarioChange() {
        const scenario = this.scenarios().find(s => s.id === this.selectedScenarioId());
        if (scenario) {
            await this.loadDefaultValues(scenario);
        }
    }

    async loadDefaultValues(scenario: Scenario) {
        this.isLoading.set(true);
        try {
            const charStatusFilename = scenario.files['CHARACTER_STATUS'];
            if (!charStatusFilename) {
                throw new Error('Character status file not defined for this scenario');
            }

            const path = `${scenario.baseDir}/${charStatusFilename}`;
            const content = await firstValueFrom(this.http.get(path, { responseType: 'text' }));

            if (!content) {
                throw new Error('Character status file is empty');
            }

            const parseTag = (tag: string) => {
                // Match <!tag|default|label> or <!tag|default> or <!tag>
                // Use * instead of + to allow empty default values
                const regex = new RegExp(`<!${tag}(?:\\|([^|>]*))?(?:\\|([^>]*))?>`);
                const match = content.match(regex);
                if (match) {
                    const defaultValue = match[1] ? match[1].trim() : '';
                    const label = match[2] ? match[2].trim() : '';
                    return { defaultValue, label };
                }
                return null;
            };

            const keys = ['name', 'faction', 'background', 'interests', 'appearance', 'coreValues'] as const;
            for (const key of keys) {
                // Map camelCase key to snake_case tag for core_values
                const tagName = key === 'coreValues' ? 'uc_core_values' : `uc_${key}`;
                const result = parseTag(tagName);
                if (result) {
                    this.profile[key].set(result.defaultValue);
                    // The labels computed signal already provides localized labels.
                    // If the intent was to override with scenario-specific labels,
                    // a separate signal or mechanism would be needed.
                    // For now, we'll keep the computed signal as the source of truth for labels.
                    // The original line `this.labels[key] = result.label;` was incorrect
                    // because `labels` is a computed signal, not a mutable object.
                }
            }

        } catch (e) {
            console.error('Failed to load default values from scenario', e);
            const ui = this.ui();
            this.snackBar.open(ui.GEN_FAILED.replace('{error}', (e as Error).message), ui.CLOSE, {
                duration: 5000,
                panelClass: ['snackbar-error']
            });
        } finally {
            this.isLoading.set(false);
        }
    }

    selectAlignment(val: string) {
        this.profile.faction.set(val);
    }

    isFormValid(): boolean {
        return !!(this.profile.name() &&
            this.profile.faction() &&
            this.profile.background() &&
            this.profile.interests() &&
            this.profile.appearance() &&
            this.profile.coreValues());
    }

    async start() {
        if (!this.isFormValid()) return;

        this.isLoading.set(true);
        try {
            const profileData = {
                name: this.profile.name(),
                faction: this.profile.faction(),
                background: this.profile.background(),
                interests: this.profile.interests(),
                appearance: this.profile.appearance(),
                coreValues: this.profile.coreValues()
            };
            const scenario = this.scenarios().find(s => s.id === this.selectedScenarioId());
            if (scenario) {
                await this.engine.startNewGame(profileData, scenario);
                this.dialogRef.close(true);
            }
        } catch (e) {
            console.error('Failed to start new game', e);
        } finally {
            this.isLoading.set(false);
        }
    }

    cancel() {
        this.dialogRef.close();
    }
}
