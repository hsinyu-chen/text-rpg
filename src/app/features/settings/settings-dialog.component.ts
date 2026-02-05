import { Component, inject, signal, computed, ComponentRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
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
import { MatSnackBar } from '@angular/material/snack-bar';
import { PortalModule, ComponentPortal, CdkPortalOutletAttachedRef } from '@angular/cdk/portal';
import { GameEngineService } from '../../core/services/game-engine.service';
import { GameStateService } from '../../core/services/game-state.service';
import { LLMProviderRegistryService } from '../../core/services/llm-provider-registry.service';
import { GoogleDriveService } from '../../core/services/google-drive.service';
import { LoadingService } from '../../core/services/loading.service';
import { LLMSettingsComponent } from '../../core/services/llm-provider';
import { getLanguagesList } from '../../core/constants/locales';

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
    MatProgressSpinnerModule,
    PortalModule
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss'
})
export class SettingsDialogComponent {
  private dialogRef = inject(MatDialogRef<SettingsDialogComponent>);
  private engine = inject(GameEngineService);
  state = inject(GameStateService);
  private providerRegistry = inject(LLMProviderRegistryService);
  loading = inject(LoadingService);
  private driveService = inject(GoogleDriveService);
  private snackBar = inject(MatSnackBar);

  // Active provider selection
  activeProvider = signal('gemini');
  providers = [
    { id: 'gemini', name: 'Gemini (Cloud)', icon: 'cloud' },
    { id: 'llama.cpp', name: 'llama.cpp (Local)', icon: 'computer' },
    { id: 'openai', name: 'OpenAI (Compatible)', icon: 'bolt' }
  ];

  // Dynamic Portal for Provider Settings
  activeSettingsPortal = computed(() => {
    const provider = this.providerRegistry.getProvider(this.activeProvider());
    if (provider?.settingsComponent) {
      return new ComponentPortal(provider.settingsComponent);
    }
    return null;
  });

  // Track the instance of the dynamic component
  private activeComponentRef = signal<LLMSettingsComponent | null>(null);

  // Common UI settings
  fontSize = signal(16);
  fontFamily = signal('sans-serif');
  exchangeRate = signal(30);
  currency = signal('TWD');
  enableConversion = signal(false);
  screensaverType = signal<'invaders' | 'code'>('invaders');
  idleOnBlur = signal(false);

  // Language Settings
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

  onPortalAttached(ref: CdkPortalOutletAttachedRef): void {
    if (ref instanceof ComponentRef) {
      this.activeComponentRef.set(ref.instance as LLMSettingsComponent);
    }
  }

  isValid = computed(() => {
    // Shared validation
    if (this.outputLanguage() === 'custom' && !this.customOutputLanguage().trim()) return false;
    if (this.fontFamily() === 'custom' && !this.customFontName().trim()) return false;

    // Provider Specific validation (Polymorphic)
    const component = this.activeComponentRef();
    return component ? component.isValid() : true;
  });

  constructor() {
    this.loadSettings();
  }

  private loadSettings(): void {
    // Load active provider
    this.activeProvider.set(localStorage.getItem('llm_provider') || 'gemini');

    // Load shared UI settings
    const current = this.state.config();
    if (current) {
      this.fontSize.set(current.fontSize || 16);

      // Font parsing
      const standardFonts = this.fontFamilies.map(f => f.value); // Use existing fontFamilies for comparison
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

      // Language parsing
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

  save(): void {
    const selectedProviderId = this.activeProvider();

    // 1. Persist the provider selection
    localStorage.setItem('llm_provider', selectedProviderId);

    // 2. Set as active in registry
    if (this.providerRegistry.hasProvider(selectedProviderId)) {
      this.providerRegistry.setActive(selectedProviderId);
    }

    const providerInstance = this.providerRegistry.getActive();
    const componentInstance = this.activeComponentRef();

    // 3. Polymorphic Save with verification to prevent cross-provider pollution
    if (componentInstance && providerInstance) {
      // Basic check: we only save if the ComponentRef exists and matches the active provider.
      // Since components are swapped via portals, we trust the registry and activeComponentRef pairing
      // but we still want to be careful about passing the right settings to the right provider.
      providerInstance.saveConfig(componentInstance.getSettings());
    }

    // 4. Save Common UI Config via Engine (provider-agnostic)
    const commonConfig = {
      fontSize: this.fontSize(),
      fontFamily: this.fontFamily() === 'custom' ? this.customFontName() : this.fontFamily(),
      exchangeRate: this.exchangeRate(),
      currency: this.currency(),
      enableConversion: this.enableConversion(),
      screensaverType: this.screensaverType(),
      idleOnBlur: this.idleOnBlur(),
      outputLanguage: this.outputLanguage() === 'custom' ? this.customOutputLanguage() : this.outputLanguage(),
    };

    this.engine.saveConfig(commonConfig);

    this.dialogRef.close();
  }
  async uploadSettings(): Promise<void> {
    this.loading.show('Uploading settings to Cloud...');
    try {
      const config = this.state.config();
      if (!config) {
        this.snackBar.open('No configuration to save.', 'Close', { duration: 3000 });
        return;
      }

      const content = JSON.stringify(config, null, 2);

      if (!this.driveService.isAuthenticated()) {
        await this.driveService.login();
      }

      const files = await this.driveService.listFiles('appDataFolder');
      const existing = files.find(f => f.name === 'settings.json');

      if (existing) {
        await this.driveService.updateFile(existing.id, content);
      } else {
        await this.driveService.createFile('appDataFolder', 'settings.json', content);
      }

      this.snackBar.open('Settings uploaded successfully.', 'OK', { duration: 3000 });
    } catch (error) {
      console.error('Upload settings failed', error);
      this.handleCloudError();
    } finally {
      this.loading.hide();
    }
  }

  async downloadSettings(): Promise<void> {
    this.loading.show('Downloading settings from Cloud...');
    try {
      if (!this.driveService.isAuthenticated()) {
        await this.driveService.login();
      }

      const files = await this.driveService.listFiles('appDataFolder');
      const settingsFile = files.find(f => f.name === 'settings.json');

      if (!settingsFile) {
        this.snackBar.open('No settings.json found in Cloud.', 'Close', { duration: 3000 });
        return;
      }

      const content = await this.driveService.readFile(settingsFile.id);
      const config = JSON.parse(content);
      this.engine.importConfig(config);
      this.snackBar.open('Settings imported. Please reopen settings to see changes.', 'Close', { duration: 5000 });
      this.dialogRef.close();
    } catch (error) {
      console.error('Download settings failed', error);
      this.handleCloudError();
    } finally {
      this.loading.hide();
    }
  }

  private handleCloudError(): void {
    localStorage.removeItem('gdrive_access_token');

    const snackRef = this.snackBar.open(
      'Cloud sync failed. Click to re-authenticate.',
      'Re-Auth',
      { duration: 10000 }
    );

    firstValueFrom(snackRef.onAction()).then(async () => {
      try {
        await this.driveService.login();
        this.snackBar.open('Re-authenticated. Please try again.', 'OK', { duration: 3000 });
      } catch {
        this.snackBar.open('Re-authentication failed.', 'Close', { duration: 3000 });
      }
    });
  }
}
