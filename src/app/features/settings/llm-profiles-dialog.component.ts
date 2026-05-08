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
  templateUrl: './llm-profiles-dialog.component.html',
  styleUrl: './llm-profiles-dialog.component.scss'
})
export class LLMProfilesDialogComponent {
  dialogRef = inject(MatDialogRef<LLMProfilesDialogComponent>);
}
