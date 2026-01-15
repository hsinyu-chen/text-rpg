import { Component, inject, signal, computed, effect, isDevMode } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BreakpointObserver, LayoutModule } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { SidebarComponent } from './features/sidebar/sidebar.component';
import { ChatComponent } from './features/chat/chat.component';
import { AutoSaveService } from './core/services/auto-save.service';
import { GameEngineService } from './core/services/game-engine.service';
import { GameStateService } from './core/services/game-state.service';
import { SettingsDialogComponent } from './features/settings/settings-dialog.component';
import { map } from 'rxjs';
import { LoadingService } from './core/services/loading.service';
import { LLMProviderInitService } from './core/services/llm-provider-init.service';
import { IdleService } from './core/services/idle.service';
import { SpaceInvadersComponent } from './features/screensaver/space-invaders.component';
import { CodeScreensaverComponent } from './features/screensaver/code-screensaver.component';

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
    CodeScreensaverComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  host: {
    '(window:beforeunload)': 'cleanup()'
  }
})
export class AppComponent {
  engine = inject(GameEngineService);
  state = inject(GameStateService);
  loading = inject(LoadingService);
  dialog = inject(MatDialog);
  private breakpointObserver = inject(BreakpointObserver);
  private providerInit = inject(LLMProviderInitService);
  idleService = inject(IdleService);

  // Responsive signals


  // Responsive signals
  isMobile = toSignal(
    this.breakpointObserver.observe('(max-width: 800px)').pipe(map(result => result.matches)),
    { initialValue: false }
  );

  // Manual toggle
  sidebarOpen = signal(true);

  // Computed state for sidenav
  sidenavOpened = computed(() => this.sidebarOpen());
  sidenavMode = computed(() => (this.isMobile() ? 'over' : 'side'));

  constructor() {
    // Register LLM Providers
    this.providerInit.initialize();

    // Initialize Engine (Providers must be registered first)
    this.engine.init();

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
  }

  async cleanup() {
    // DEV MODE: Keep cache enabled for fast/cheap reloading
    // PROD MODE: Cleanup cache to avoid continuous storage charges
    if (!isDevMode()) {
      await this.engine.cleanupCache();
    } else {
      console.log('[DevMode] Skipping auto-cleanup to preserve cache for reload.');
    }
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

  private autoSave = inject(AutoSaveService);
}
