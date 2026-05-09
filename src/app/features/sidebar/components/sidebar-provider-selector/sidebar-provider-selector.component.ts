import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog } from '@angular/material/dialog';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { LLMProviderRegistryService } from '@app/core/services/llm-provider-registry.service';
import { LLMConfigService } from '@app/core/services/llm-config.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { LLMProfilesDialogComponent } from '@app/features/settings/llm-profiles-dialog.component';
import { TranslatePipe } from '@app/core/i18n';

/**
 * Compact profile switcher for the left sidebar — hot-swaps the active
 * LLM profile (provider + settings) mid-session. The tune icon opens the
 * full profile manager (monorepo's LLMSettingsComponent in a dialog).
 */
@Component({
  selector: 'app-sidebar-provider-selector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ...CORE_MAT,
    MatFormFieldModule,
    MatSelectModule,
    FormsModule,
    TranslatePipe
  ],
  templateUrl: './sidebar-provider-selector.component.html',
  styleUrl: './sidebar-provider-selector.component.scss'
})
export class SidebarProviderSelectorComponent {
  private registry = inject(LLMProviderRegistryService);
  private llmConfig = inject(LLMConfigService);
  private matDialog = inject(MatDialog);
  state = inject(GameStateService);

  profiles = this.llmConfig.profiles;
  activeId = computed(() => this.llmConfig.activeProfileId());

  onChange(profileId: string): void {
    if (!profileId) return;
    this.registry.setActiveProfile(profileId);
  }

  openManager(): void {
    this.matDialog.open(LLMProfilesDialogComponent, {
      width: '720px',
      maxWidth: '95vw',
      maxHeight: '90vh',
      panelClass: 'llm-profiles-dialog-panel'
    });
  }
}
