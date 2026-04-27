import { Component, inject, signal, computed, effect, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
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
import { SettingsDialogComponent } from './features/settings/settings-dialog.component';
import { map } from 'rxjs';
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


@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    MatSidenavModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    LayoutModule,
    SidebarComponent,
    ChatComponent,
    SpaceInvadersComponent,
    CodeScreensaverComponent,
    BookListComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  engine = inject(GameEngineService);
  state = inject(GameStateService);
  session = inject(SessionService); // Public for template access if needed, or private
  loading = inject(LoadingService);
  dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private remoteUpdateSnackRef: MatSnackBarRef<TextOnlySnackBar> | null = null;
  private breakpointObserver = inject(BreakpointObserver);
  private providerInit = inject(LLMProviderInitService);
  private syncProviderInit = inject(SyncProviderInitService);
  private sync = inject(SyncService);
  idleService = inject(IdleService);

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
    const migrationService = inject(MigrationService);
    // Migrations must finish BEFORE provider init runs, since migrateLLMProfiles
    // writes seed profiles that LLMConfigService will read on its first pass.
    this.syncProviderInit.initialize();
    migrationService.runMigrations()
      .then(() => this.providerInit.initialize())
      .then(() => {
        this.engine.init();
        // Boot sync runs in parallel with session.init: first paint stays fast,
        // and SyncService internally silent-reloads the active book if remote was newer.
        // Failures are logged inside bootSync; we don't block startup on them.
        void this.sync.bootSync();
        return this.session.init();
      })
      .then(() => this.engine.startSession());

    // Initialize sidebar state based on mobile
    if (this.isMobile()) {
      this.sidebarOpen.set(false);
    }

    effect(() => {
      if (this.state.status() === 'loading') {
        this.loading.show('Synchronizing Knowledge Base...\nChecking files, uploading, and cleaning up...');
      } else {
        // Only hide if the loading service was triggered by engine status (simple check or force hide might conflict)
        // For simplicity, we can trust other components to manage their own ephemeral loading states or use a stack if needed.
        // But since engine loading is "global app initialization" mostly, let's just hide it.
        // Ideally we need a better state management but for this fix:
        if (this.loading.message().includes('Synchronizing Knowledge Base')) {
          this.loading.hide();
        }
      }
    });

    // Sync — newer remote version available for the active book.
    effect(() => {
      const update = this.sync.remoteUpdateAvailable();
      if (!update) return;
      this.handleRemoteUpdate(update.bookId);
    });

    // Sync — conflicts (both sides edited since last sync). Drain the signal
    // after handling so reruns don't double-toast.
    effect(() => {
      const list = this.sync.conflicts();
      if (list.length === 0) return;
      const snapshot = [...list];
      this.sync.conflicts.set([]);
      for (const c of snapshot) {
        if (c.resource === 'book') this.handleBookConflict(c.id, c.name);
      }
    });
  }

  private handleRemoteUpdate(bookId: string): void {
    this.remoteUpdateSnackRef?.dismiss();
    const ref = this.snackBar.open('Cloud has a newer version of this book.', 'Load', { duration: 0 });
    this.remoteUpdateSnackRef = ref;
    ref.onAction().subscribe(async () => {
      if (this.state.status() === 'generating') {
        this.snackBar.open('Wait for the current turn to finish, then try again.', 'OK', { duration: 3000 });
        return;
      }
      try {
        await this.session.loadBook(bookId, false);
      } finally {
        this.sync.remoteUpdateAvailable.set(null);
      }
    });
    ref.afterDismissed().subscribe(() => {
      if (this.remoteUpdateSnackRef === ref) this.remoteUpdateSnackRef = null;
      this.sync.remoteUpdateAvailable.set(null);
    });
  }

  private handleBookConflict(bookId: string, name?: string): void {
    const label = name ? `'${name}'` : 'a book';
    const ref = this.snackBar.open(
      `Conflict on ${label}: cloud changed and you have unsaved local edits. Local copy preserved.`,
      'Save cloud copy',
      { duration: 0 }
    );
    ref.onAction().subscribe(async () => {
      try {
        const newId = await this.sync.forkRemoteBook(bookId);
        this.snackBar.open('Cloud version saved as a separate book.', 'OK', { duration: 4000 });
        // Switch to the fork so the user can compare.
        if (this.state.status() !== 'generating') {
          await this.session.loadBook(newId, false);
        }
      } catch (e) {
        console.error('[AppComponent] forkRemoteBook failed', e);
        this.snackBar.open('Failed to download cloud copy: ' + ((e as { message?: string })?.message || 'Unknown error'), 'Close', { duration: 5000 });
      }
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
      this.bookList()!.loadBooks();
    }
  }

  closeBookList() {
    this.bookListOpen.set(false);
  }
}
