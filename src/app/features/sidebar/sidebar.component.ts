import { Component, inject, computed, signal, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';

import { GameEngineService } from '../../core/services/game-engine.service';
import { GameStateService } from '../../core/services/game-state.service';
import { SettingsDialogComponent } from '../settings/settings-dialog.component';
import { FileViewerDialogComponent } from './file-viewer-dialog.component';

import { SidebarFileSyncComponent } from './components/sidebar-file-sync/sidebar-file-sync.component';
import { SidebarContextControlsComponent } from './components/sidebar-context-controls/sidebar-context-controls.component';
import { SidebarCostPredictionComponent } from './components/sidebar-cost-prediction/sidebar-cost-prediction.component';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatDividerModule,
    MatTooltipModule,
    MatTabsModule,
    SidebarFileSyncComponent,
    SidebarContextControlsComponent,
    SidebarCostPredictionComponent
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent {
  engine = inject(GameEngineService);
  state = inject(GameStateService);
  matDialog = inject(MatDialog);

  displayMode = signal<'tokens' | 'chars'>('tokens');

  closeSidebar = output<void>();


  fileList = computed(() => {
    const list: { name: string, content: string, tokens: number }[] = [];
    const tokenCounts = this.state.fileTokenCounts();
    this.state.loadedFiles().forEach((content, name) => {
      list.push({
        name,
        content,
        tokens: tokenCounts.get(name) || 0
      });
    });
    return list;
  });

  formatCount(n: number): string {
    if (n < 1000) return n.toString();
    const k = n / 1000;
    return k.toFixed(k < 10 ? 1 : 0) + 'K';
  }

  openSettings() {
    this.matDialog.open(SettingsDialogComponent, { width: '550px' });
  }

  viewFile(initialFile: string, _content: string, editMode = false) {
    // Pass all loaded files to the dialog with the clicked file as initial selection
    this.matDialog.open(FileViewerDialogComponent, {
      panelClass: 'fullscreen-dialog',
      data: {
        files: this.state.loadedFiles(),
        initialFile,
        editMode
      }
    });
  }

  toggleDisplayMode() {
    this.displayMode.update(m => m === 'tokens' ? 'chars' : 'tokens');
  }

  close() {
    this.closeSidebar.emit();
  }
}
