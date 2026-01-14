import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { GameEngineService } from '../../../../core/services/game-engine.service';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LOCALES } from '../../../../core/constants/locales';

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
        MatProgressSpinnerModule
    ],
    templateUrl: './new-game-dialog.component.html',
    styleUrl: './new-game-dialog.component.scss'
})
export class NewGameDialogComponent {
    private engine = inject(GameEngineService);
    private dialogRef = inject(MatDialogRef<NewGameDialogComponent>);
    private http = inject(HttpClient);

    isLoading = signal(false);
    scenarios = signal<{ id: string, name: string, baseDir: string }[]>([]);
    selectedScenarioId = signal('fareast');

    profile = {
        name: signal(''),
        faction: signal(''),
        background: signal(''),
        interests: signal(''),
        appearance: signal(''),
        coreValues: signal('')
    };

    labels: Record<string, string> = {
        name: '主角名稱',
        faction: '主角陣營',
        background: '主角背景',
        interests: '興趣',
        appearance: '外貌描述',
        coreValues: '核心價值觀與行為準則'
    };

    alignments = [
        ['Lawful Good', 'Neutral Good', 'Chaotic Good'],
        ['Lawful Neutral', 'True Neutral', 'Chaotic Neutral'],
        ['Lawful Evil', 'Neutral Evil', 'Chaotic Evil']
    ];

    constructor() {
        this.init();
    }

    async init() {
        this.isLoading.set(true);
        try {
            const scenarios = await firstValueFrom(this.http.get<{ id: string, name: string, baseDir: string }[]>('assets/system_files/scenario/scenarios.json'));
            this.scenarios.set(scenarios);
            if (scenarios.length > 0) {
                this.selectedScenarioId.set(scenarios[0].id);
                await this.loadDefaultValues(scenarios[0].id);
            }
        } catch (e) {
            console.error('Failed to load scenarios', e);
        } finally {
            this.isLoading.set(false);
        }
    }

    async onScenarioChange() {
        await this.loadDefaultValues(this.selectedScenarioId());
    }

    async loadDefaultValues(scenarioId: string) {
        this.isLoading.set(true);
        try {
            let content = '';

            // Collect all potential filenames from LOCALES
            const potentialFilenames = new Set(Object.values(LOCALES).map(l => l.coreFilenames.CHARACTER_STATUS));

            for (const filename of potentialFilenames) {
                try {
                    content = await firstValueFrom(this.http.get(`assets/system_files/scenario/${scenarioId}/${filename}`, { responseType: 'text' }));
                    if (content) break; // Found it!
                } catch {
                    // Continue to next filename
                }
            }

            if (!content) {
                console.error(`Failed to load character status for ${scenarioId} from any known locale filename.`);
                throw new Error('Character status file not found');
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
                    if (result.label) {
                        this.labels[key] = result.label;
                    }
                }
            }

        } catch (e) {
            console.error('Failed to load default values from scenario', e);
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
            await this.engine.startNewGame(profileData, this.selectedScenarioId());
            this.dialogRef.close(true);
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
