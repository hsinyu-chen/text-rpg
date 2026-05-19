import { Component, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FORM_MAT } from '@app/shared/material/material-groups';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { LLMProviderRegistryService } from '@app/core/services/llm-provider-registry.service';
import { LLMConfigService } from '@app/core/services/llm-config.service';
import { LoadingService } from '@app/core/services/loading.service';
import { SettingsSyncService } from '@app/core/services/settings-sync.service';
import { getLanguagesList } from '@app/core/constants/locales';
import { UI_LOCALES, type InterfaceLanguageSetting, TranslatePipe } from '@app/core/i18n';
import { LLMProfilesDialogComponent } from './llm-profiles-dialog.component';
import { ProviderDebugDialogComponent } from '@app/features/multi-agent-save/provider-debug-dialog.component';
import { BridgeService } from '@app/core/services/dev/bridge.service';
import { AppAgentHintDirective } from '@app/core/services/agent-hints/agent-hints.directive';

@Component({
  selector: 'app-settings-dialog',
  standalone: true,
  imports: [
    ...FORM_MAT,
    MatButtonModule,
    MatIconModule,
    MatDialogModule,
    MatSlideToggleModule,
    MatTabsModule,
    MatExpansionModule,
    MatSliderModule,
    MatProgressSpinnerModule,
    FormsModule,
    TranslatePipe,
    AppAgentHintDirective,
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss'
})
export class SettingsDialogComponent {
  private dialogRef = inject(MatDialogRef<SettingsDialogComponent>);
  private engine = inject(GameEngineService);
  state = inject(GameStateService);
  private appConfig = inject(AppConfigStore);
  private providerRegistry = inject(LLMProviderRegistryService);
  llmConfig = inject(LLMConfigService);
  private matDialog = inject(MatDialog);
  loading = inject(LoadingService);
  private settingsSync = inject(SettingsSyncService);
  bridge = inject(BridgeService);

  /** List of profiles, reactive to the storage layer. */
  profiles = this.llmConfig.profiles;

  /** Currently selected profile id (editable by user; persisted on Save). */
  selectedProfileId = signal<string | null>(this.llmConfig.activeProfileId());

  /** Label for the currently-selected profile (for tooltips / display). */
  selectedProfileLabel = computed(() => {
    const id = this.selectedProfileId();
    const profile = this.profiles().find(p => p.id === id);
    return profile ? `${profile.name} (${profile.provider})` : 'None';
  });

  fontSize = signal(16);
  fontFamily = signal('sans-serif');
  exchangeRate = signal(30);
  currency = signal('TWD');
  enableConversion = signal(false);
  screensaverType = signal<'invaders' | 'code'>('invaders');
  idleOnBlur = signal(false);
  enableAdultDeclaration = signal(true);
  engineMode = signal<'single' | 'two-call'>('single');
  outputLanguage = signal('default');
  customOutputLanguage = signal('');
  languages: { value: string; label: string }[] = getLanguagesList();

  /**
   * UI-language picker — closed set: 'system' ∪ registered locale ids. The
   * 'system' entry's display label is rendered via the `settings.systemDefault`
   * translate key in the template (so it follows the resolved language), so
   * the option list itself only carries `value` + native-label pairs.
   */
  interfaceLanguage = signal<InterfaceLanguageSetting>('system');
  interfaceLanguages: { value: InterfaceLanguageSetting; label: string }[] = [
    { value: 'system', label: '' },
    ...UI_LOCALES.map(l => ({ value: l.id, label: l.label })),
  ];

  currencies = [
    { code: 'TWD', name: 'New Taiwan Dollar (NT$)', symbol: 'NT$' },
    { code: 'USD', name: 'US Dollar ($)', symbol: '$' },
    { code: 'JPY', name: 'Japanese Yen (¥)', symbol: '¥' },
    { code: 'KRW', name: 'South Korean Won (₩)', symbol: '₩' },
    { code: 'EUR', name: 'Euro (€)', symbol: '€' },
    { code: 'CNY', name: 'Chinese Yuan (¥)', symbol: 'CN¥' }
  ];

  fontFamilies = [
    { name: 'Iansui', value: "'Iansui', serif" },
    { name: 'Serif', value: "'Georgia', 'Cambria', 'Times New Roman', serif" },
    { name: 'Sans-Serif', value: 'Roboto, "Helvetica Neue", sans-serif' },
    { name: 'Monospace', value: "'Fira Code', 'Courier New', monospace" },
    { name: 'Custom...', value: 'custom' }
  ];

  customFontName = signal('');

  // Debug bridge — local edit copies; applied on Save.
  debugBridgeUrl = signal(this.bridge.url());
  debugBridgeEnabled = signal(this.bridge.enabled());
  debugBridgeClientId = signal(this.bridge.clientId());
  debugBridgeEvalEnabled = signal(this.bridge.evalEnabled());
  bridgeTestInProgress = signal(false);
  bridgeTestResult = signal<{ ok: boolean; error?: string } | null>(null);

  isValid = computed(() => {
    if (this.outputLanguage() === 'custom' && !this.customOutputLanguage().trim()) return false;
    if (this.fontFamily() === 'custom' && !this.customFontName().trim()) return false;
    return true;
  });

  constructor() {
    this.loadSettings();
  }

  private loadSettings(): void {
    this.selectedProfileId.set(this.llmConfig.activeProfileId());

    this.fontSize.set(this.appConfig.fontSize() || 16);

    const standardFonts = this.fontFamilies.map(f => f.value);
    const currentFontFamily = this.appConfig.fontFamily();
    if (currentFontFamily && !standardFonts.includes(currentFontFamily)) {
      this.fontFamily.set('custom');
      this.customFontName.set(currentFontFamily);
    } else {
      this.fontFamily.set(currentFontFamily || 'sans-serif');
    }

    this.exchangeRate.set(this.appConfig.exchangeRate());
    this.currency.set(this.appConfig.currency());
    this.enableConversion.set(this.appConfig.enableConversion());
    this.screensaverType.set(this.appConfig.screensaverType());
    this.idleOnBlur.set(this.appConfig.idleOnBlur());
    this.enableAdultDeclaration.set(this.appConfig.enableAdultDeclaration());
    this.engineMode.set(this.appConfig.engineMode());

    const lang = this.appConfig.outputLanguage();
    const isPresetLang = this.languages.some(l => l.value === lang);
    if (!isPresetLang && lang !== 'default') {
      this.outputLanguage.set('custom');
      this.customOutputLanguage.set(lang);
    } else {
      this.outputLanguage.set(lang);
    }

    this.interfaceLanguage.set(this.appConfig.interfaceLanguage());
  }

  openProfilesManager(): void {
    this.matDialog.open(LLMProfilesDialogComponent, {
      width: '720px',
      maxWidth: '95vw',
      maxHeight: '90vh',
      panelClass: 'llm-profiles-dialog-panel'
    });
  }

  openProviderDebug(): void {
    this.matDialog.open(ProviderDebugDialogComponent, {
      maxWidth: '95vw',
      maxHeight: '90vh',
    });
  }

  async save(): Promise<void> {
    const pickedId = this.selectedProfileId();
    if (pickedId && pickedId !== this.llmConfig.activeProfileId()) {
      this.providerRegistry.setActiveProfile(pickedId);
    }

    const commonConfig = {
      fontSize: this.fontSize(),
      fontFamily: this.fontFamily() === 'custom' ? this.customFontName() : this.fontFamily(),
      exchangeRate: this.exchangeRate(),
      currency: this.currency(),
      enableConversion: this.enableConversion(),
      screensaverType: this.screensaverType(),
      idleOnBlur: this.idleOnBlur(),
      enableAdultDeclaration: this.enableAdultDeclaration(),
      engineMode: this.engineMode(),
      outputLanguage: this.outputLanguage() === 'custom' ? this.customOutputLanguage() : this.outputLanguage(),
      interfaceLanguage: this.interfaceLanguage()
    };

    await this.engine.saveConfig(commonConfig);

    this.bridge.setUrl(this.debugBridgeUrl().trim());
    this.bridge.setEnabled(this.debugBridgeEnabled());
    this.bridge.setClientId(this.debugBridgeClientId());
    this.bridge.setEvalEnabled(this.debugBridgeEvalEnabled());

    this.dialogRef.close();
  }

  onDebugBridgeUrlChange(url: string): void {
    this.debugBridgeUrl.set(url);
    // Stale result is worse than no result — clear as soon as the URL changes.
    this.bridgeTestResult.set(null);
  }

  async testBridgeConnection(): Promise<void> {
    const url = this.debugBridgeUrl().trim();
    if (!url || this.bridgeTestInProgress()) return;
    this.bridgeTestInProgress.set(true);
    this.bridgeTestResult.set(null);
    try {
      const res = await this.bridge.testConnection(url);
      this.bridgeTestResult.set(res);
    } finally {
      this.bridgeTestInProgress.set(false);
    }
  }

  async uploadSettings(): Promise<void> {
    try {
      await this.settingsSync.upload();
    } catch {
      // Service surfaces error via snackbar.
    }
  }

  async downloadSettings(): Promise<void> {
    try {
      const applied = await this.settingsSync.download();
      if (applied) this.dialogRef.close();
    } catch {
      // Service surfaces error via snackbar.
    }
  }

}
