import { describe, expect, it, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Clipboard } from '@angular/cdk/clipboard';
import { AutoUpdateDialogComponent } from './auto-update-dialog.component';
import { HunkApplyController } from './hunk-apply-controller';
import { HunkAutoFixService } from './hunk-auto-fix.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { I18nService } from '@app/core/i18n';

class StubHunkApplyController {
  groupingComplete = signal(true);
  bind(): void { /* host wiring is irrelevant to the gating test */ }
  init(): void { /* no real grouping needed */ }
  hasSelectedUpdates(): boolean { return true; }
  hasSelectedUnresolvedError(): boolean { return false; }
}

describe('AutoUpdateDialogComponent stats gating', () => {
  const hasStatsYaml = signal(false);

  function makeComponent(): AutoUpdateDialogComponent {
    TestBed.configureTestingModule({
      providers: [
        { provide: MatDialogRef, useValue: { close: () => undefined } },
        { provide: MAT_DIALOG_DATA, useValue: { updates: [] } },
        { provide: MatDialog, useValue: {} },
        { provide: MatSnackBar, useValue: { open: () => undefined } },
        { provide: Clipboard, useValue: { copy: () => true } },
        { provide: AppConfigStore, useValue: { outputLanguage: signal('en') } },
        { provide: GameStateService, useValue: { hasStatsYaml } },
        { provide: I18nService, useValue: { translate: (k: string) => k } },
        { provide: HunkApplyController, useClass: StubHunkApplyController },
        { provide: HunkAutoFixService, useValue: {} },
      ],
    });
    // Construct the component directly rather than via createComponent: the gating
    // computed needs no view, and skipping view creation avoids resolving the
    // external templateUrl/styleUrl — which the bare-vitest runner can't do (only
    // `ng test` inlines component resources).
    return TestBed.runInInjectionContext(() => new AutoUpdateDialogComponent());
  }

  beforeEach(() => {
    hasStatsYaml.set(false);
    TestBed.resetTestingModule();
  });

  it('does not block Apply-to-Act when the Book has no stats ledger', () => {
    const c = makeComponent();
    hasStatsYaml.set(false);
    expect(c.blockApplyCurrentForStats()).toBe(false);
  });

  it('blocks Apply-to-Act when the Book ships a stats ledger', () => {
    const c = makeComponent();
    hasStatsYaml.set(true);
    expect(c.blockApplyCurrentForStats()).toBe(true);
  });
});
