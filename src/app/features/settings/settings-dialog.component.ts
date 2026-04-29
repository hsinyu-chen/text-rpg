import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { GameEngineService } from '../../core/services/game-engine.service';
import { GameStateService } from '../../core/services/game-state.service';
import { LLMProviderRegistryService } from '../../core/services/llm-provider-registry.service';
import { LLMConfigService } from '../../core/services/llm-config.service';
import { LoadingService } from '../../core/services/loading.service';
import { SettingsSyncService } from '../../core/services/settings-sync.service';
import { getLanguagesList } from '../../core/constants/locales';
import { LLMProfilesDialogComponent } from './llm-profiles-dialog.component';

@Component({
  selector: 'app-settings-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatDialogModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTabsModule,
    MatExpansionModule,
    MatSliderModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss'
})
export class SettingsDialogComponent {
  private dialogRef = inject(MatDialogRef<SettingsDialogComponent>);
  private engine = inject(GameEngineService);
  state = inject(GameStateService);
  private providerRegistry = inject(LLMProviderRegistryService);
  llmConfig = inject(LLMConfigService);
  private matDialog = inject(MatDialog);
  loading = inject(LoadingService);
  private settingsSync = inject(SettingsSyncService);

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

  // Common UI settings
  fontSize = signal(16);
  fontFamily = signal('sans-serif');
  exchangeRate = signal(30);
  currency = signal('TWD');
  enableConversion = signal(false);
  screensaverType = signal<'invaders' | 'code'>('invaders');
  idleOnBlur = signal(false);
  enableAdultDeclaration = signal(true);
  outputLanguage = signal('default');
  customOutputLanguage = signal('');
  languages: { value: string; label: string }[] = getLanguagesList();

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

    const current = this.state.config();
    if (current) {
      this.fontSize.set(current.fontSize || 16);

      const standardFonts = this.fontFamilies.map(f => f.value);
      if (current.fontFamily && !standardFonts.includes(current.fontFamily)) {
        this.fontFamily.set('custom');
        this.customFontName.set(current.fontFamily);
      } else {
        this.fontFamily.set(current.fontFamily || 'sans-serif');
      }

      this.exchangeRate.set(current.exchangeRate ?? 30);
      this.currency.set(current.currency || 'TWD');
      this.enableConversion.set(current.enableConversion ?? false);
      this.screensaverType.set(current.screensaverType ?? 'invaders');
      this.idleOnBlur.set(current.idleOnBlur ?? false);
      this.enableAdultDeclaration.set(current.enableAdultDeclaration ?? true);

      const lang = current.outputLanguage || 'default';
      const isPresetLang = this.languages.some(l => l.value === lang);
      if (!isPresetLang && lang !== 'default') {
        this.outputLanguage.set('custom');
        this.customOutputLanguage.set(lang);
      } else {
        this.outputLanguage.set(lang);
      }
    }
  }

  openProfilesManager(): void {
    this.matDialog.open(LLMProfilesDialogComponent, {
      width: '720px',
      maxWidth: '95vw',
      maxHeight: '90vh',
      panelClass: 'llm-profiles-dialog-panel'
    });
  }

  save(): void {
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
      outputLanguage: this.outputLanguage() === 'custom' ? this.customOutputLanguage() : this.outputLanguage()
    };

    this.engine.saveConfig(commonConfig);

    this.dialogRef.close();
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
