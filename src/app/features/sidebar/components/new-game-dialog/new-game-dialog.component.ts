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
import { MatTabsModule } from '@angular/material/tabs';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialog } from '@angular/material/dialog';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService } from '../../../../core/services/game-state.service';
import { getUIStrings } from '../../../../core/constants/engine-protocol';
import { IdentityOption, Scenario, WorldPreset } from '../../../../core/models/types';
import { getLocale } from '../../../../core/constants/locales';
import { FileViewerDialogComponent } from '../../file-viewer-dialog.component';
import { WORLD_PRESETS } from '../../../../core/constants/world-preset';
import { WorldCompletionValidator } from '../../../../core/services/file-agent/world-completion-validator';
import { LLMConfigService } from '../../../../core/services/llm-config.service';

const BLANK_FILES_EN = [
    '1.Base_Settings.md', '2.Story_Outline.md', '3.Character_Status.md',
    '4.Assets.md', '5.Tech_Equipment.md', '6.Factions_and_World.md',
    '7.Magic_and_Skills.md', '8.Plans.md', '9.Inventory.md'
];

const BLANK_FILES_ZH = [
    '1.基礎設定.md', '2.劇情綱要.md', '3.人物狀態.md',
    '4.資產.md', '5.科技裝備.md', '6.勢力與世界.md',
    '7.魔法與技能.md', '8.計畫.md', '9.物品欄.md'
];

// ─── Component ──────────────────────────────────────────────────────────────

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
        MatTooltipModule,
        MatTabsModule,
        MatDividerModule
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
    private matDialog = inject(MatDialog);
    private llmConfig = inject(LLMConfigService);

    // ─── Shared ───────────────────────────────────────────────────────────
    isLoading = signal(false);
    activeTabIndex = signal(1);

    // ─── Pre-build tab ────────────────────────────────────────────────────
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
        appearance: signal('')
    };

    labels = computed(() => {
        const lang = this.state.config()?.outputLanguage || 'default';
        const ui = getUIStrings(lang);
        return {
            name: ui.USER_NAME,
            faction: ui.USER_FACTION,
            background: ui.USER_BACKGROUND,
            interests: ui.USER_INTERESTS,
            appearance: ui.USER_APPEARANCE
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
        if (scenario) await this.loadDefaultValues(scenario);
    }

    async loadDefaultValues(scenario: Scenario) {
        this.isLoading.set(true);
        try {
            const charStatusFilename = scenario.files['CHARACTER_STATUS'];
            if (!charStatusFilename) throw new Error('Character status file not defined for this scenario');
            const path = `${scenario.baseDir}/${charStatusFilename}`;
            const content = await firstValueFrom(this.http.get(path, { responseType: 'text' }));
            if (!content) throw new Error('Character status file is empty');

            const parseTag = (tag: string) => {
                const regex = new RegExp(`<!${tag}(?:\\|([^|>]*))?(?:\\|([^>]*))?>`);
                const match = content.match(regex);
                if (match) return { defaultValue: match[1] ? match[1].trim() : '' };
                return null;
            };

            const keys = ['name', 'faction', 'background', 'interests', 'appearance'] as const;
            for (const key of keys) {
                const result = parseTag(`uc_${key}`);
                if (result) this.profile[key].set(result.defaultValue);
            }
        } catch (e) {
            console.error('Failed to load default values from scenario', e);
            const ui = this.ui();
            this.snackBar.open(ui.GEN_FAILED.replace('{error}', (e as Error).message), ui.CLOSE, {
                duration: 5000, panelClass: ['snackbar-error']
            });
        } finally {
            this.isLoading.set(false);
        }
    }

    selectAlignment(val: string) { this.profile.faction.set(val); }

    isFormValid(): boolean {
        return !!(this.profile.name() && this.profile.faction() && this.profile.background() &&
            this.profile.interests() && this.profile.appearance());
    }

    async start() {
        if (!this.isFormValid()) return;
        this.isLoading.set(true);
        try {
            const profileData = {
                name: this.profile.name(), faction: this.profile.faction(),
                background: this.profile.background(), interests: this.profile.interests(),
                appearance: this.profile.appearance()
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

    // ─── Generate tab ─────────────────────────────────────────────────────
    llmProfiles = this.llmConfig.profiles;
    generateProfileId = signal<string>(this.llmConfig.activeProfileId() ?? '');

    private langPresets = (): WorldPreset[] => WORLD_PRESETS[this.isZhLang() ? 'zh' : 'en'] ?? [];
    localizedPresets = computed(() => this.langPresets());
    currentIdentities = computed(() => {
        const id = this.selectedPresetId();
        if (!id) return [];
        return this.langPresets().find((p: WorldPreset) => p.id === id)?.identities ?? [];
    });

    selectedPresetId = signal('');
    genre = signal('');
    tone = signal('');
    setting = signal('');

    protagonistName = signal('');
    protagonistGender = signal('');
    protagonistAge = signal('');
    protagonistAlignment = signal('');
    protagonistBackground = signal('');
    protagonistInterests = signal('');
    protagonistAppearance = signal('');
    protagonistIdentity = signal('');
    npcPreferences = signal('');
    specialRequests = signal('');
    isCustomIdentity = signal(false);

    genderOptions = computed(() => {
        const isZh = this.isZhLang();
        return isZh
            ? [{ value: '男', label: '男' }, { value: '女', label: '女' }, { value: '其他', label: '其他' }]
            : [{ value: 'Male', label: 'Male' }, { value: 'Female', label: 'Female' }, { value: 'Other', label: 'Other' }];
    });

    private isZhLang(): boolean {
        const lang = this.state.config()?.outputLanguage;
        return getLocale(lang).id === 'zh-TW';
    }

    private applyIdentityPreset(identity: IdentityOption): void {
        this.protagonistIdentity.set(identity.value);
        this.protagonistBackground.set(identity.desc);
        this.protagonistAlignment.set(identity.alignment ?? '');
        this.protagonistInterests.set(identity.interests ?? '');
        this.protagonistAppearance.set(identity.appearance ?? '');
        this.npcPreferences.set(identity.npcHints ?? '');
        this.specialRequests.set(identity.specialRequests);
    }

    applyPreset(presetId: string): void {
        this.selectedPresetId.set(presetId);
        this.isCustomIdentity.set(false);
        const preset = this.langPresets().find((p: WorldPreset) => p.id === presetId);
        if (!preset) return;
        this.genre.set(preset.genre);
        this.tone.set(preset.tone);
        this.setting.set(preset.setting);
        this.protagonistGender.set('');
        this.protagonistAge.set('');
        this.protagonistAppearance.set('');
        if (preset.identities.length > 0) this.applyIdentityPreset(preset.identities[0]);
    }

    onIdentityChange(value: string): void {
        if (value === '__custom__') {
            this.isCustomIdentity.set(true);
            this.protagonistIdentity.set('');
            this.protagonistBackground.set('');
            this.protagonistAlignment.set('');
            this.protagonistInterests.set('');
            this.npcPreferences.set('');
            this.specialRequests.set('');
            return;
        }
        const identity = this.currentIdentities().find(i => i.value === value);
        if (identity) this.applyIdentityPreset(identity);
    }

    resetToPresetIdentity(): void {
        this.isCustomIdentity.set(false);
        const identities = this.currentIdentities();
        if (identities.length > 0) this.applyIdentityPreset(identities[0]);
    }

    isCreateWorldValid(): boolean {
        return !!(this.genre().trim() && this.tone().trim() && this.setting().trim() &&
            this.protagonistName().trim() && this.protagonistIdentity().trim() &&
            this.protagonistAlignment().trim() && this.protagonistBackground().trim() &&
            this.protagonistInterests().trim() && this.protagonistAppearance().trim());
    }

    async submitCreateWorld(): Promise<void> {
        if (!this.isCreateWorldValid()) return;
        this.isLoading.set(true);
        try {
            const isZh = this.isZhLang();
            const baseDir = isZh
                ? 'assets/system_files/scenario/blank_world_zh'
                : 'assets/system_files/scenario/blank_world_en';
            const fileNames = isZh ? BLANK_FILES_ZH : BLANK_FILES_EN;
            const promptFile = isZh
                ? 'assets/system_files/create_world_prompt_zh.md'
                : 'assets/system_files/create_world_prompt_en.md';
            const charStatusFile = isZh ? '3.人物狀態.md' : '3.Character_Status.md';
            const unset = (zh: string, en: string) => isZh ? zh : en;

            const fileContentsArr = await Promise.all(
                fileNames.map(name => firstValueFrom(this.http.get(`${baseDir}/${name}`, { responseType: 'text' })))
            );
            const filesMap = new Map<string, string>();
            fileNames.forEach((name, i) => {
                let content = fileContentsArr[i];
                if (name === charStatusFile) {
                    content = content
                        .replace(/\{\{PROTAGONIST_NAME\}\}/g, this.protagonistName().trim())
                        .replace(/\{\{PROTAGONIST_GENDER\}\}/g, this.protagonistGender().trim() || unset('（未指定）', '(unspecified)'))
                        .replace(/\{\{PROTAGONIST_AGE\}\}/g, this.protagonistAge().trim() || unset('（年齡）', '(Age)'))
                        .replace(/\{\{PROTAGONIST_ALIGNMENT\}\}/g, this.protagonistAlignment().trim())
                        .replace(/\{\{PROTAGONIST_BACKGROUND\}\}/g, this.protagonistBackground().trim())
                        .replace(/\{\{PROTAGONIST_INTERESTS\}\}/g, this.protagonistInterests().trim())
                        .replace(/\{\{PROTAGONIST_APPEARANCE\}\}/g, this.protagonistAppearance().trim());
                }
                filesMap.set(name, content);
            });

            const promptTemplate = await firstValueFrom(
                this.http.get(promptFile, { responseType: 'text' })
            );
            const agentPrompt = promptTemplate
                .replace(/\{\{GENRE\}\}/g, this.genre().trim())
                .replace(/\{\{TONE\}\}/g, this.tone().trim())
                .replace(/\{\{SETTING\}\}/g, this.setting().trim())

                .replace(/\{\{PROTAGONIST_NAME\}\}/g, this.protagonistName().trim())
                .replace(/\{\{PROTAGONIST_GENDER\}\}/g, this.protagonistGender().trim() || unset('（未指定）', '(unspecified)'))
                .replace(/\{\{PROTAGONIST_AGE\}\}/g, this.protagonistAge().trim() || unset('（年齡）', '(Age)'))
                .replace(/\{\{PROTAGONIST_ALIGNMENT\}\}/g, this.protagonistAlignment().trim())
                .replace(/\{\{PROTAGONIST_IDENTITY\}\}/g, this.protagonistIdentity().trim())
                .replace(/\{\{PROTAGONIST_BACKGROUND\}\}/g, this.protagonistBackground().trim())
                .replace(/\{\{PROTAGONIST_INTERESTS\}\}/g, this.protagonistInterests().trim())
                .replace(/\{\{PROTAGONIST_APPEARANCE\}\}/g, this.protagonistAppearance().trim())
                .replace(/\{\{NPC_PREFERENCES\}\}/g, this.npcPreferences().trim() || unset('（由世界設定決定）', '(let the world setting decide)'))
                .replace(/\{\{SPECIAL_REQUESTS\}\}/g, this.specialRequests().trim() || unset('（無）', '(none)'));

            const worldName = `${this.protagonistName().trim()} — ${this.genre().trim()}`;
            const isZhLang = isZh;
            const validator = new WorldCompletionValidator(
                () => filesMap,
                {
                    placeholders: isZhLang
                        ? ['由世界生成器填入', '（種族）', '（起始位置）']
                        : ['To be filled in by the world generator', '(Race)'],
                    retryMessage: (files) => isZhLang
                        ? `驗收失敗：以下檔案仍有未填寫的佔位符，請繼續補完後再次呼叫 submitResponse：\n${files.map(f => `- ${f}`).join('\n')}`
                        : `Validation failed: the following files still contain unfilled placeholders. Fill them all before calling submitResponse again:\n${files.map(f => `- ${f}`).join('\n')}`
                }
            );

            this.dialogRef.close();
            this.matDialog.open(FileViewerDialogComponent, {
                panelClass: 'fullscreen-dialog',
                data: {
                    files: filesMap,
                    initialFile: fileNames[0],
                    createWorldMode: true,
                    initialAgentPrompt: agentPrompt,
                    worldName,
                    completionValidator: validator,
                    initialProfileId: this.generateProfileId() || undefined
                }
            });
        } catch (err) {
            console.error('[CreateWorld] Failed:', err);
            this.snackBar.open('Failed to load world template files.', 'Close', { duration: 5000 });
        } finally {
            this.isLoading.set(false);
        }
    }

    // ─── Shared ───────────────────────────────────────────────────────────
    cancel() { this.dialogRef.close(); }
}
