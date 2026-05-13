import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { CORE_MAT, FORM_MAT } from '@app/shared/material/material-groups';
import { AgentHintRegistry } from './agent-hints.registry';
import type { HintAction } from './agent-hints.types';

/**
 * Dev-only panel listing every manifest entry with one-click test buttons
 * (highlight / focus / activate). Used to verify the registry independent
 * of the LLM round-trip — eliminates "did the agent emit the right URL?"
 * from the test loop. Opened via dev-bridge `agent_open_hint_debug`.
 *
 * Modeless on purpose (no backdrop, anchored top-right) so flash / breadcrumb
 * toast on the target is visible behind the panel.
 */
@Component({
  selector: 'app-agent-hint-debug-dialog',
  standalone: true,
  imports: [...CORE_MAT, ...FORM_MAT, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="hint-debug-panel">
      <div class="header">
        <span>Agent Hint Debug — {{ entries().length }} entries</span>
        <span class="counts">
          mounted {{ mountedCount() }} / unmounted {{ entries().length - mountedCount() }}
        </span>
        <button mat-icon-button (click)="dialogRef.close()" matTooltip="Close">
          <mat-icon>close</mat-icon>
        </button>
      </div>

      <mat-form-field appearance="outline" subscriptSizing="dynamic" class="filter-field">
        <mat-label>Filter (path / description / keywords)</mat-label>
        <input matInput [ngModel]="filter()" (ngModelChange)="filter.set($event)" />
        @if (filter()) {
          <button mat-icon-button matSuffix (click)="filter.set('')">
            <mat-icon>clear</mat-icon>
          </button>
        }
      </mat-form-field>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th>Description</th>
              <th class="cell-center">Mnt</th>
              <th class="cell-center">Act</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (e of filtered(); track e.path) {
              <tr [class.row-mounted]="e.mounted" [class.row-unmounted]="!e.mounted">
                <td class="path">{{ e.path }}</td>
                <td class="desc">{{ e.description }}</td>
                <td class="cell-center" [title]="e.mounted ? 'directive attached' : 'not in DOM — flash will show breadcrumb'">
                  {{ e.mounted ? '✓' : '✗' }}
                </td>
                <td class="cell-center" [title]="e.activatable ? 'activate URL allowed' : 'highlight only'">
                  {{ e.activatable ? '⚡' : '·' }}
                </td>
                <td class="actions">
                  <button mat-stroked-button class="action-btn" (click)="open(e.path, 'highlight')">flash</button>
                  <button mat-stroked-button class="action-btn" (click)="open(e.path, 'focus')">focus</button>
                  @if (e.activatable) {
                    <button mat-stroked-button color="warn" class="action-btn" (click)="open(e.path, 'activate')">activate</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="empty">No entries match.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: [`
    .hint-debug-panel {
      display: flex;
      flex-direction: column;
      width: 720px;
      max-width: 90vw;
      max-height: 80vh;
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface);
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      padding: 12px;
      font-size: 12px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
      font-weight: 600;
    }
    .header .counts { color: var(--mat-sys-on-surface-variant); font-weight: 400; flex: 1; }
    .filter-field { width: 100%; margin-bottom: 8px; }
    .table-scroll { overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-family: 'Consolas', monospace; }
    th, td { padding: 4px 8px; text-align: left; vertical-align: middle; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    th { position: sticky; top: 0; background: var(--mat-sys-surface-container-high); font-size: 11px; }
    .cell-center { text-align: center; }
    .path { font-size: 11px; white-space: nowrap; }
    .desc { font-size: 11px; color: var(--mat-sys-on-surface-variant); }
    .actions { white-space: nowrap; }
    .action-btn { font-size: 11px; min-width: 0; padding: 0 8px; line-height: 24px; }
    .row-unmounted .path, .row-unmounted .desc { opacity: 0.5; }
    .empty { text-align: center; padding: 24px; color: var(--mat-sys-on-surface-variant); }
  `],
})
export class AgentHintDebugDialogComponent {
  readonly dialogRef = inject(MatDialogRef<AgentHintDebugDialogComponent>);
  private readonly registry = inject(AgentHintRegistry);

  readonly filter = signal('');
  private readonly refreshTick = signal(0);

  readonly entries = computed<{ path: string; description: string; mounted: boolean; activatable: boolean }[]>(() => {
    this.refreshTick();
    const report = this.registry.getMountedReport();
    const allPaths = [...report.mounted, ...report.unmounted].sort();
    return allPaths.map(path => {
      const entry = this.registry.findByPath(path);
      return {
        path,
        description: entry ? this.registry.describe(path) : path,
        mounted: report.mounted.includes(path),
        activatable: !!entry?.entry.activatable,
      };
    });
  });

  readonly mountedCount = computed(() => this.entries().filter(e => e.mounted).length);

  readonly filtered = computed(() => {
    const f = this.filter().trim().toLowerCase();
    if (!f) return this.entries();
    return this.entries().filter(e =>
      e.path.toLowerCase().includes(f) ||
      e.description.toLowerCase().includes(f),
    );
  });

  open(path: string, action: HintAction): void {
    this.registry.openTarget(path, action);
    setTimeout(() => this.refreshTick.update(n => n + 1), 400);
  }
}
