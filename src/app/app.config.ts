import { ApplicationConfig, provideZonelessChangeDetection, isDevMode, inject } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideMarkdown } from 'ngx-markdown';
import { MatDialog } from '@angular/material/dialog';
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
import { KVStore } from './core/services/kv/kv-store';
import { LocalStorageKVStore } from './core/services/kv/local-storage-kv-store';
import { SYNC_BACKEND_PROVIDERS } from './core/services/sync/sync-backends.providers';
import { FILE_VIEWER_OPENER, FileViewerOpener } from './core/services/dev/file-viewer-opener.token';
import { FileViewerDialogComponent } from './features/sidebar/file-viewer-dialog.component';
import { FULLSCREEN_DIALOG_CONFIG } from './shared/material/dialog-presets';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideHttpClient(),
    provideMarkdown(),

    { provide: KVStore, useClass: LocalStorageKVStore },

    ...SYNC_BACKEND_PROVIDERS,

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

    // FileViewer opener — abstraction so the dev BridgeService (Core layer)
    // can pop the dialog without importing the FileViewerDialogComponent
    // (Feature layer) directly. Provided at app root because both MatDialog
    // and the component live above the core/feature boundary.
    {
      provide: FILE_VIEWER_OPENER,
      useFactory: (): FileViewerOpener => {
        const dialog = inject(MatDialog);
        const findOpenDialog = () =>
          dialog.openDialogs.find(d => d.componentInstance instanceof FileViewerDialogComponent);
        return {
          isOpen: () => findOpenDialog() !== undefined,
          open: (req) => {
            const existing = findOpenDialog();
            if (existing) {
              // Already open — switch the active file instead of refusing.
              // Common case: LLM emits several `app://file/...` links and the
              // user clicks them in turn; without this we'd silently no-op
              // every click after the first.
              const inst = existing.componentInstance as FileViewerDialogComponent;
              if (req.initialFile && inst.data.files.has(req.initialFile)) {
                inst.activeFile.set(req.initialFile);
              }
              return { alreadyOpen: true };
            }
            dialog.open(FileViewerDialogComponent, {
              ...FULLSCREEN_DIALOG_CONFIG,
              data: req,
            });
            return { alreadyOpen: false };
          }
        };
      }
    },

    // sw.js wraps ngsw-worker.js (via importScripts) and adds a message-driven
    // fetch proxy used by BackgroundFetchService to keep LLM streaming alive
    // when the page is briefly suspended on mobile.
    provideServiceWorker('sw.js', {
      // Tauri webview ships its own background lifecycle; SW gives no benefit there
      // and can confuse the custom protocol — only register on real browsers.
      enabled: !isDevMode() && typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window) && !('__TAURI__' in window),
      registrationStrategy: 'registerWhenStable:30000'
    })
  ]
};
