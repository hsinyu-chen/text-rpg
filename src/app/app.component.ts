import { Component, inject, signal, computed, effect, viewChild } from '@angular/core';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarRef, TextOnlySnackBar } from '@angular/material/snack-bar';
import { BreakpointObserver, LayoutModule } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { SidebarComponent } from './features/sidebar/sidebar.component';
import { ChatComponent } from './features/chat/chat.component';
import { GameEngineService } from './core/services/game-engine.service';
import { GameStateService } from './core/services/game-state.service';
import { AppConfigStore } from './core/services/app-config-store';
import { SettingsDialogComponent } from './features/settings/settings-dialog.component';
import { firstValueFrom, map } from 'rxjs';
import { filter } from 'rxjs/operators';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { WINDOW } from './core/tokens/window.token';
import { LoadingService } from './core/services/loading.service';
import { LLMProviderInitService } from './core/services/llm-provider-init.service';
import { SyncProviderInitService } from './core/services/sync/sync-provider-init.service';
import { SyncService } from './core/services/sync/sync.service';
import { IdleService } from './core/services/idle.service';
import { SpaceInvadersComponent } from './features/screensaver/space-invaders.component';
import { CodeScreensaverComponent } from './features/screensaver/code-screensaver.component';
import { MigrationService } from './core/services/migration.service';
import { BookListComponent } from './features/sidebar/components/book-list/book-list.component';
import { SessionService } from './core/services/session.service';
import { WakeLockService } from './core/services/wake-lock.service';
import { BackgroundFetchService } from './core/services/background-fetch.service';
import { BridgeService } from './core/services/dev/bridge.service';
import { I18nService, TranslatePipe } from './core/i18n';


@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    MatSidenavModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    LayoutModule,
    SidebarComponent,
    ChatComponent,
    SpaceInvadersComponent,
    CodeScreensaverComponent,
    BookListComponent,
    TranslatePipe
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  engine = inject(GameEngineService);
  state = inject(GameStateService);
  protected appConfig = inject(AppConfigStore);
  session = inject(SessionService); // Public for template access if needed, or private
  loading = inject(LoadingService);
  dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private i18n = inject(I18nService);
  private isSyncingKB = false;
  private remoteUpdateSnackRef: MatSnackBarRef<TextOnlySnackBar> | null = null;
  private breakpointObserver = inject(BreakpointObserver);
  private providerInit = inject(LLMProviderInitService);
  private syncProviderInit = inject(SyncProviderInitService);
  private sync = inject(SyncService);
  idleService = inject(IdleService);
  // Eagerly construct so its effect() registers and holds a screen wake lock
  // during generation — prevents mobile screen-off from killing the API stream.
  private wakeLock = inject(WakeLockService);
  private bgFetch = inject(BackgroundFetchService);
  // Eagerly construct so its connect-effect registers; gated internally by isDevMode().
  private bridge = inject(BridgeService);
  private swUpdate = inject(SwUpdate);
  private win = inject(WINDOW);
  private appUpdateSnackRef: MatSnackBarRef<TextOnlySnackBar> | null = null;
  private pendingAppUpdateRetry = signal(false);

  // Responsive signals


  // Responsive signals
  isMobile = toSignal(
    this.breakpointObserver.observe('(max-width: 800px)').pipe(map(result => result.matches)),
    { initialValue: false }
  );

  bookList = viewChild(BookListComponent);

  // Manual toggle
  sidebarOpen = signal(true);
  bookListOpen = signal(false);

  // Computed state for sidenav
  sidenavOpened = computed(() => this.sidebarOpen());
  sidenavMode = computed(() => (this.isMobile() ? 'over' : 'side'));

  constructor() {
    // Install the SW-routed fetch shim. On the very first visit the SW is not
    // yet a controller, so the first turn that fires before SW activation
    // falls through to direct fetch — every subsequent turn (and every turn
    // after a reload) goes through the SW.
    this.bgFetch.install();

    const migrationService = inject(MigrationService);
    this.syncProviderInit.initialize();
    void migrationService.runMigrations()
      .then(() => this.providerInit.initialize())
      .then(async () => {
        await this.engine.init();
        // Boot sync runs in parallel with session.init: first paint stays fast,
        // and SyncService internally silent-reloads the active book if remote was newer.
        // Failures are logged inside bootSync; we don't block startup on them.
        void this.sync.bootSync();
        await this.session.init();
      })
      // loadFiles must run AFTER session.init() resolves — it reads file_store
      // and writes state.loadedFiles + saves the active book. Running it in
      // parallel with loadBook (which clearFiles()'s + re-populates file_store)
      // produces a race where loadFiles reads a half-populated store and then
      // persists the truncated set back into books_store, losing files on
      // every reload. bumpTimestamp=false: pure re-read, not a content change.
      .then(() => this.session.loadFiles(false, false))
      .then(() => this.engine.startSession());

    // Initialize sidebar state based on mobile
    if (this.isMobile()) {
      this.sidebarOpen.set(false);
    }

    effect(() => {
      if (this.state.status() === 'loading') {
        this.isSyncingKB = true;
        this.loading.show(this.i18n.translate('app.syncingKBMessage'));
      } else if (this.isSyncingKB) {
        // Local flag avoids comparing loading.message() against a translation —
        // a language switch mid-load would never match and the overlay would stick.
        this.isSyncingKB = false;
        this.loading.hide();
      }
    });

    // Sync — newer remote version available for the active book.
    effect(() => {
      const update = this.sync.remoteUpdateAvailable();
      if (!update) return;
      this.handleRemoteUpdate(update.bookId);
    });

    // PWA — service worker fetched a new app version; ask user to reload to activate.
    // SwUpdate.isEnabled is false in dev and Tauri (we disabled SW there), so the
    // signal simply never updates in those contexts.
    effect(() => {
      if (this.versionReady()) this.handleAppUpdate();
    });

    // If the user clicked Reload during a turn we deferred — re-prompt the
    // moment the turn finishes (status leaves 'generating'), instead of using
    // an arbitrary timer.
    effect(() => {
      if (!this.pendingAppUpdateRetry()) return;
      if (this.state.status() === 'generating') return;
      this.pendingAppUpdateRetry.set(false);
      this.handleAppUpdate();
    });
  }

  private versionReady = toSignal(
    this.swUpdate.versionUpdates.pipe(
      filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY')
    ),
    { initialValue: null }
  );

  private handleAppUpdate(): void {
    this.appUpdateSnackRef?.dismiss();
    const ref = this.snackBar.open(
      this.i18n.translate('app.newAppVersion'),
      this.i18n.translate('app.reloadAction'),
      { duration: 0 }
    );
    this.appUpdateSnackRef = ref;
    firstValueFrom(ref.onAction()).then(async () => {
      if (this.state.status() === 'generating') {
        // VERSION_READY only fires once. Set a flag and let the constructor's
        // effect re-call handleAppUpdate when status actually leaves
        // 'generating'. A timer-based retry would either re-pester the user
        // mid-turn or miss the moment entirely if the turn ran long.
        this.snackBar.open(
          this.i18n.translate('app.waitTurnFinish'),
          this.i18n.translate('app.okAction'),
          { duration: 3000 }
        );
        this.pendingAppUpdateRetry.set(true);
        return;
      }
      try {
        await this.swUpdate.activateUpdate();
      } finally {
        this.win.location.reload();
      }
    }).catch(() => { /* dismissed without action */ });
    void firstValueFrom(ref.afterDismissed()).then(() => {
      if (this.appUpdateSnackRef === ref) this.appUpdateSnackRef = null;
    });
  }

  private handleRemoteUpdate(bookId: string): void {
    this.remoteUpdateSnackRef?.dismiss();
    const ref = this.snackBar.open(
      this.i18n.translate('app.cloudNewerVersion'),
      this.i18n.translate('app.loadAction'),
      { duration: 0 }
    );
    this.remoteUpdateSnackRef = ref;
    firstValueFrom(ref.onAction()).then(async () => {
      if (this.state.status() === 'generating') {
        this.snackBar.open(
          this.i18n.translate('app.waitTurnFinishRetry'),
          this.i18n.translate('app.okAction'),
          { duration: 3000 }
        );
        return;
      }
      try {
        await this.session.loadBook(bookId, false);
      } finally {
        this.sync.remoteUpdateAvailable.set(null);
      }
    }).catch(() => { /* dismissed without action */ });
    void firstValueFrom(ref.afterDismissed()).then(() => {
      if (this.remoteUpdateSnackRef === ref) this.remoteUpdateSnackRef = null;
      this.sync.remoteUpdateAvailable.set(null);
    });
  }


  openSettings() {
    this.dialog.open(SettingsDialogComponent, {
      width: '550px',
      disableClose: !this.state.isConfigured()
    });
  }

  toggleSidebar() {
    this.sidebarOpen.update(v => !v);
  }

  closeSidebar() {
    this.sidebarOpen.set(false);
  }

  toggleBookList() {
    this.bookListOpen.update(v => !v);
    if (this.bookListOpen() && this.bookList()) {
      void this.bookList()!.loadBooks();
    }
  }

  closeBookList() {
    this.bookListOpen.set(false);
  }
}
