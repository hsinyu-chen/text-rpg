import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { LLMProviderRegistryService } from '../../../../core/services/llm-provider-registry.service';
import { LLMConfigService } from '../../../../core/services/llm-config.service';
import { GameStateService } from '../../../../core/services/game-state.service';
import { LLMProfilesDialogComponent } from '../../../settings/llm-profiles-dialog.component';

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
    CommonModule,
    FormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule
  ],
  template: `
    <div class="selector-row">
      @if (profiles().length === 0) {
        <button mat-stroked-button class="create-btn" (click)="openManager()">
          <mat-icon>add</mat-icon>
          Create LLM Profile
        </button>
      } @else {
        <mat-form-field appearance="outline" class="profile-field" subscriptSizing="dynamic">
          <mat-label>Profile</mat-label>
          <mat-select [ngModel]="activeId()"
                      (ngModelChange)="onChange($event)"
                      [disabled]="state.isBusy()">
            @for (p of profiles(); track p.id) {
              <mat-option [value]="p.id">
                {{ p.name }} <span class="provider-tag">({{ p.provider }})</span>
              </mat-option>
            }
          </mat-select>
        </mat-form-field>
        <button mat-icon-button
                class="configure-btn"
                matTooltip="Manage LLM profiles"
                [disabled]="state.isBusy()"
                (click)="openManager()">
          <mat-icon>tune</mat-icon>
        </button>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      padding: 10px 12px 4px;
      background: rgba(255, 255, 255, 0.02);
    }
    .selector-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .profile-field {
      flex: 1 1 auto;
      font-size: 12px;
    }
    .configure-btn {
      flex: 0 0 auto;
      color: #aaa;
      &:hover { color: #fff; }
    }
    .create-btn {
      flex: 1 1 auto;
      font-size: 12px;
    }
    .provider-tag {
      opacity: 0.6;
      font-size: 11px;
    }
    ::ng-deep .profile-field .mat-mdc-form-field-infix {
      min-height: 36px;
      padding: 4px 0;
    }
    ::ng-deep .profile-field .mat-mdc-select-trigger {
      font-size: 12px;
    }
    mat-icon {
      font-size: 16px;
      height: 16px;
      width: 16px;
      vertical-align: middle;
      margin-right: 4px;
    }
  `]
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
