import { Component, inject, viewChild, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { GameEngineService } from '../../core/services/game-engine.service';
import { getLanguagesList } from '../../core/constants/locales';
import { GoogleDriveService } from '../../core/services/google-drive.service';
import { LoadingService } from '../../core/services/loading.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { GeminiSettingsComponent } from './gemini-settings/gemini-settings.component';
import { LlamaSettingsComponent } from './llama-settings/llama-settings.component';

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
    MatSliderModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    GeminiSettingsComponent,
    LlamaSettingsComponent
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss'
})
export class SettingsDialogComponent {
  engine = inject(GameEngineService);
  dialogRef = inject(MatDialogRef);
  loading = inject(LoadingService);
  private driveService = inject(GoogleDriveService);
  private snackBar = inject(MatSnackBar);

  // Provider components (for accessing their settings)
  geminiSettings = viewChild<GeminiSettingsComponent>('geminiSettings');
  llamaSettings = viewChild<LlamaSettingsComponent>('llamaSettings');

  // Provider selection
  activeProvider = signal<'gemini' | 'llama.cpp'>('gemini');
  providers = [
    { id: 'gemini', name: 'Gemini (Cloud)', icon: 'cloud' },
    { id: 'llama.cpp', name: 'llama.cpp (Local)', icon: 'computer' }
  ];

  // Shared UI settings
  fontSize = signal<number | undefined>(undefined);
  fontFamily = signal<string | undefined>(undefined);
  exchangeRate = signal(30);
  currency = signal('TWD');
  enableConversion = signal(false);
  screensaverType = signal<'invaders' | 'code'>('invaders');

  // Language Settings
  outputLanguage = signal('default');
  customOutputLanguage = signal('');

  languages = getLanguagesList();

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

  customFontName = signal('iansui');

  constructor() {
    this.loadSettings();
  }

  private loadSettings(): void {
    // Load active provider
    this.activeProvider.set((localStorage.getItem('llm_provider') as 'gemini' | 'llama.cpp') || 'gemini');

    // Load shared UI settings
    const current = this.engine.config();
    if (current) {
      this.fontSize.set(current.fontSize);
      this.exchangeRate.set(current.exchangeRate ?? 30);
      this.currency.set(current.currency || 'TWD');
      this.enableConversion.set(current.enableConversion ?? false);
      this.screensaverType.set(current.screensaverType ?? 'invaders');

      const isPreset = this.fontFamilies.some(f => f.value === current.fontFamily);
      if (current.fontFamily && !isPreset) {
        this.fontFamily.set('custom');
        this.customFontName.set(current.fontFamily);
      } else {
        this.fontFamily.set(current.fontFamily);
      }
      // Load Language
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
    // Save active provider
    localStorage.setItem('llm_provider', this.activeProvider());

    // Save provider-specific settings
    if (this.activeProvider() === 'gemini') {
      const gemini = this.geminiSettings();
      if (gemini) {
        const settings = gemini.getSettings();
        this.engine.saveConfig(settings.apiKey, settings.modelId, {
          fontSize: this.fontSize(),
          fontFamily: this.fontFamily() === 'custom' ? this.customFontName() : this.fontFamily(),
          enableCache: settings.enableCache,
          exchangeRate: this.exchangeRate(),
          currency: this.currency(),
          enableConversion: this.enableConversion(),
          screensaverType: this.screensaverType(),
          outputLanguage: this.outputLanguage() === 'custom' ? this.customOutputLanguage() : this.outputLanguage()
        });
      }
    } else {
      const llama = this.llamaSettings();
      if (llama) {
        const settings = llama.getSettings();
        localStorage.setItem('llama_base_url', settings.baseUrl);
        localStorage.setItem('llama_model_id', settings.modelId);
      }

      // Still save shared UI settings via engine
      this.engine.saveConfig(
        localStorage.getItem('gemini_api_key') || '',
        localStorage.getItem('gemini_model_id') || 'gemini-3-flash-preview',
        {
          fontSize: this.fontSize(),
          fontFamily: this.fontFamily() === 'custom' ? this.customFontName() : this.fontFamily(),
          exchangeRate: this.exchangeRate(),
          currency: this.currency(),
          enableConversion: this.enableConversion(),
          screensaverType: this.screensaverType(),
          outputLanguage: this.outputLanguage() === 'custom' ? this.customOutputLanguage() : this.outputLanguage()
        }
      );
    }

    this.dialogRef.close();
  }

  isValid(): boolean {
    if (this.activeProvider() === 'gemini') {
      const gemini = this.geminiSettings();
      return gemini?.isValid() ?? false;
    } else {
      const llama = this.llamaSettings();
      return llama?.isValid() ?? true;
    }
  }

  async uploadSettings(): Promise<void> {
    this.loading.show('Uploading settings to Cloud...');
    try {
      const config = this.engine.config();
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
