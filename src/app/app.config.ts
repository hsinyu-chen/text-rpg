import { ApplicationConfig, provideZonelessChangeDetection, isDevMode } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideMarkdown } from 'ngx-markdown';
import {
  LLMManager,
  LLMProviderRegistry,
  BrowserIndexedDBStorage
} from '@hcs/llm-core';
import {
  LLM_STORAGE_TOKEN,
  LLM_TRANSLATIONS,
  DEFAULT_LLM_TRANSLATIONS
} from '@hcs/llm-angular-common';
import { provideServiceWorker } from '@angular/service-worker';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideHttpClient(),
    provideMarkdown(),

    // Monorepo wiring — the LLMSettingsComponent profile manager and the
    // stateless provider classes expect these tokens provided at app root.
    { provide: LLMProviderRegistry, useFactory: () => new LLMProviderRegistry() },
    { provide: LLM_STORAGE_TOKEN, useFactory: () => new BrowserIndexedDBStorage('TextRPGLLMProfiles') },
    {
      provide: LLMManager,
      useFactory: (storage: BrowserIndexedDBStorage, registry: LLMProviderRegistry) =>
        new LLMManager(storage, registry),
      deps: [LLM_STORAGE_TOKEN, LLMProviderRegistry]
    },
    { provide: LLM_TRANSLATIONS, useValue: DEFAULT_LLM_TRANSLATIONS },
    provideServiceWorker('ngsw-worker.js', {
      // Tauri webview ships its own background lifecycle; SW gives no benefit there
      // and can confuse the custom protocol — only register on real browsers.
      enabled: !isDevMode() && !('__TAURI_INTERNALS__' in window) && !('__TAURI__' in window),
      registrationStrategy: 'registerWhenStable:30000'
    })
  ]
};
