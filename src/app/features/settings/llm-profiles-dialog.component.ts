import { Component, inject, ViewEncapsulation } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { LLMSettingsComponent } from '@hcs/llm-angular-settings';

/**
 * Host dialog for the monorepo's LLMSettingsComponent profile manager.
 *
 * LLMSettingsComponent was built as a full-screen standalone modal — its
 * `.settings-overlay` pins position:fixed with its own dimmer backdrop,
 * and its `.settings-container` caps at 600px centered. That's correct
 * for top-level use but fights MatDialog when embedded. We neutralize
 * the standalone chrome here and rebuild the flex/min-height chain
 * end-to-end so the scroll region lives on the inner `.configs-list` /
 * `.config-editor` (the intended scroll container in the monorepo's
 * standalone layout) rather than bubbling up to mat-mdc-dialog-container.
 *
 * The chain is: mat-mdc-dialog-surface → our host → hcs-llm-settings
 * → .settings-overlay → .settings-container → .configs-list/.config-editor.
 * Every parent gets `display:flex; flex-direction:column; min-height:0`
 * so the terminal scroll child can claim the remaining height; the
 * `.settings-header` stays pinned via `flex: 0 0 auto`.
 */
@Component({
  selector: 'app-llm-profiles-dialog',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [MatDialogModule, MatIconModule, LLMSettingsComponent],
  template: `<hcs-llm-settings (settingsClosed)="dialogRef.close()"></hcs-llm-settings>`,
  styles: [`
    /* --- MatDialog surface: let our host claim full dialog height. --- */
    .llm-profiles-dialog-panel .mat-mdc-dialog-surface {
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden !important;
    }
    .llm-profiles-dialog-panel .mat-mdc-dialog-container {
      padding: 0 !important;
    }

    /* --- Flex chain: host → hcs-llm-settings → overlay → container. --- */
    app-llm-profiles-dialog {
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1 1 auto;
      overflow: hidden;
    }
    app-llm-profiles-dialog hcs-llm-settings {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }

    /* --- Neutralize the standalone overlay (no fixed positioning, no
           backdrop), but keep it as a flex column so the chain survives. --- */
    app-llm-profiles-dialog .settings-overlay {
      position: static !important;
      background: transparent !important;
      backdrop-filter: none !important;
      width: 100% !important;
      height: auto !important;
      display: flex !important;
      flex-direction: column !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
      z-index: auto !important;
    }

    /* --- Container: drop chrome + fixed size caps, keep flex column so
           .configs-list / .config-editor remains the scroll container. --- */
    app-llm-profiles-dialog .settings-container {
      max-width: none !important;
      max-height: none !important;
      width: 100% !important;
      background: transparent !important;
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      display: flex !important;
      flex-direction: column !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
      /* overflow:hidden is inherited from the base, keep it — scroll lives below. */
    }

    /* Pin the header so only the editor/list scrolls. */
    app-llm-profiles-dialog .settings-header {
      flex: 0 0 auto !important;
    }
    app-llm-profiles-dialog .configs-list,
    app-llm-profiles-dialog .config-editor {
      flex: 1 1 auto !important;
      min-height: 0 !important;
      overflow-y: auto !important;
    }

    /* --- Grid-item hardening (CSS Grid defaults min-width:auto, which
           equals <input> min-content ≈ 20ch and punches a horizontal
           scrollbar on narrow dialogs). --- */
    app-llm-profiles-dialog .form-group,
    app-llm-profiles-dialog .form-group-vertical,
    app-llm-profiles-dialog .form-grid > * {
      min-width: 0 !important;
    }
    app-llm-profiles-dialog input,
    app-llm-profiles-dialog select {
      min-width: 0 !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
    }
  `]
})
export class LLMProfilesDialogComponent {
  dialogRef = inject(MatDialogRef<LLMProfilesDialogComponent>);
}
