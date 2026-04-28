import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';

import { SyncService, SnapshotPreOpError } from '../../../core/services/sync/sync.service';
import { SnapshotMeta } from '../../../core/services/sync/sync.types';
import { DialogService } from '../../../core/services/dialog.service';
import { LoadingService } from '../../../core/services/loading.service';
import { GameStateService } from '../../../core/services/game-state.service';
import { SaveNameDialogComponent, SaveNameDialogData } from '../save-name-dialog/save-name-dialog.component';

@Component({
    selector: 'app-advanced-sync-tools-dialog',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        DatePipe,
        MatDialogModule,
        MatTabsModule,
        MatButtonModule,
        MatIconModule,
        MatTableModule,
        MatProgressSpinnerModule,
        MatTooltipModule
    ],
    template: `
    <h2 mat-dialog-title>
      <mat-icon class="title-icon">build</mat-icon>
      Advanced Sync Tools
      <span class="backend-tag">{{ syncService.activeBackendId() === 's3' ? 'S3' : 'Drive' }}</span>
    </h2>

    <mat-dialog-content>
      <mat-tab-group [(selectedIndex)]="selectedTab" animationDuration="0ms">

        <!-- ============ Force Sync ============ -->
        <mat-tab label="Force Sync">
          <div class="tab-pad">
            <div class="warn-box">
              <mat-icon>warning_amber</mat-icon>
              <div>
                <strong>Force operations bypass the newer-wins logic and are destructive.</strong>
                A safety snapshot is taken automatically before each operation; if it
                fails you'll be asked whether to continue without one.
              </div>
            </div>

            <div class="action-row">
              <div class="action-info">
                <h4>Force Push <span class="arrow">this device → cloud</span></h4>
                <p>
                  Cloud becomes an exact mirror of this device. A
                  <code>forcePush</code> snapshot of the current cloud is taken
                  first so you can restore it later.
                </p>
              </div>
              <button mat-flat-button color="warn"
                  [disabled]="state.isBusy() || busy()"
                  (click)="runForcePush()">
                <mat-icon>cloud_upload</mat-icon>
                Force Push
              </button>
            </div>

            <div class="action-row">
              <div class="action-info">
                <h4>Force Pull <span class="arrow">cloud → this device</span></h4>
                <p>
                  This device becomes an exact mirror of the cloud. A
                  <code>forcePull</code> snapshot of the current local state is
                  taken first so you can restore it.
                </p>
              </div>
              <button mat-flat-button color="warn"
                  [disabled]="state.isBusy() || busy()"
                  (click)="runForcePull()">
                <mat-icon>cloud_download</mat-icon>
                Force Pull
              </button>
            </div>
          </div>
        </mat-tab>

        <!-- ============ Snapshots ============ -->
        <mat-tab label="Snapshots">
          <div class="tab-pad">
            <div class="snapshots-toolbar">
              <button mat-stroked-button color="primary"
                  [disabled]="state.isBusy() || busy()"
                  (click)="createManualSnapshot()">
                <mat-icon>add_a_photo</mat-icon>
                Create Snapshot
              </button>
              <button mat-stroked-button
                  [disabled]="busy()"
                  (click)="refreshSnapshots()">
                <mat-icon>refresh</mat-icon>
                Refresh
              </button>
              <span class="spacer"></span>
              @if (!loadingList()) {
                <span class="snapshot-count">
                  {{ snapshots().length }} snapshot{{ snapshots().length === 1 ? '' : 's' }}
                </span>
              }
            </div>

            @if (loadingList()) {
              <div class="loading-row">
                <mat-spinner diameter="24"></mat-spinner>
                <span>Loading snapshots…</span>
              </div>
            } @else if (snapshots().length === 0) {
              <div class="empty-list">
                <mat-icon>inbox</mat-icon>
                <p>No snapshots yet. Force push / pull / restore will create one
                automatically, or press <em>Create Snapshot</em> above.</p>
              </div>
            } @else {
            <table mat-table [dataSource]="snapshots()" class="snap-table">

              <ng-container matColumnDef="time">
                <th mat-header-cell *matHeaderCellDef>Time</th>
                <td mat-cell *matCellDef="let s">{{ s.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</td>
              </ng-container>

              <ng-container matColumnDef="trigger">
                <th mat-header-cell *matHeaderCellDef>Trigger</th>
                <td mat-cell *matCellDef="let s">
                  <span class="trigger-badge" [attr.data-trigger]="s.trigger">{{ s.trigger }}</span>
                </td>
              </ng-container>

              <ng-container matColumnDef="counts">
                <th mat-header-cell *matHeaderCellDef matTooltip="books / collections / tombstones">Items</th>
                <td mat-cell *matCellDef="let s" class="num">
                  {{ s.bookCount }}/{{ s.collectionCount }}/{{ s.tombstoneCount }}
                </td>
              </ng-container>

              <ng-container matColumnDef="size">
                <th mat-header-cell *matHeaderCellDef>Size</th>
                <td mat-cell *matCellDef="let s" class="num">{{ formatSize(s.sizeBytes) }}</td>
              </ng-container>

              <ng-container matColumnDef="device">
                <th mat-header-cell *matHeaderCellDef>Device</th>
                <td mat-cell *matCellDef="let s">
                  <span [matTooltip]="s.deviceId || ''">{{ deviceLabel(s) }}</span>
                </td>
              </ng-container>

              <ng-container matColumnDef="note">
                <th mat-header-cell *matHeaderCellDef>Note</th>
                <td mat-cell *matCellDef="let s">
                  <input class="note-input" type="text" [value]="s.note || ''"
                      placeholder="(none)"
                      [disabled]="busy()"
                      (blur)="commitNote(s, $event)"
                      (keydown.enter)="commitNote(s, $event)" />
                </td>
              </ng-container>

              <ng-container matColumnDef="actions">
                <th mat-header-cell *matHeaderCellDef>Actions</th>
                <td mat-cell *matCellDef="let s" class="actions-cell">
                  <button mat-icon-button color="primary"
                      [disabled]="state.isBusy() || busy()"
                      matTooltip="Restore" (click)="restore(s)">
                    <mat-icon>restore</mat-icon>
                  </button>
                  <button mat-icon-button color="warn"
                      [disabled]="state.isBusy() || busy()"
                      matTooltip="Delete" (click)="deleteOne(s)">
                    <mat-icon>delete</mat-icon>
                  </button>
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="cols"></tr>
              <tr mat-row *matRowDef="let row; columns: cols"></tr>
            </table>
            }
          </div>
        </mat-tab>
      </mat-tab-group>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="dialogRef.close()">Close</button>
    </mat-dialog-actions>
  `,
    styles: [`
    .title-icon {
        vertical-align: middle;
        margin-right: 6px;
    }
    .backend-tag {
        font-size: 0.7em;
        background: rgba(66, 133, 244, 0.18);
        color: #4285f4;
        padding: 2px 8px;
        border-radius: 10px;
        margin-left: 8px;
        vertical-align: middle;
    }
    mat-dialog-content {
        min-height: 360px;
        max-height: 70vh;
        padding: 0 !important;
    }
    .tab-pad {
        padding: 16px 24px 8px;
    }
    .warn-box {
        display: flex;
        gap: 12px;
        padding: 12px;
        background: rgba(244, 67, 54, 0.08);
        border: 1px solid rgba(244, 67, 54, 0.35);
        border-radius: 4px;
        margin-bottom: 16px;
        font-size: 0.85em;
        line-height: 1.4;
        mat-icon { color: #f44336; flex-shrink: 0; }
    }
    .action-row {
        display: flex;
        gap: 16px;
        align-items: center;
        padding: 12px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 4px;
        margin-bottom: 12px;
    }
    .action-info {
        flex: 1;
        h4 {
            margin: 0 0 4px;
            font-size: 0.95em;
            .arrow {
                opacity: 0.55;
                font-weight: 400;
                font-size: 0.85em;
                margin-left: 6px;
            }
        }
        p {
            margin: 0;
            font-size: 0.8em;
            opacity: 0.8;
            line-height: 1.4;
            code {
                background: rgba(255,255,255,0.08);
                padding: 1px 6px;
                border-radius: 3px;
                font-size: 0.95em;
            }
        }
    }

    .snapshots-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
    }
    .snapshots-toolbar .spacer { flex: 1; }
    .snapshot-count {
        font-size: 0.8em;
        opacity: 0.6;
    }
    .loading-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 24px;
        opacity: 0.8;
    }
    .empty-list {
        text-align: center;
        padding: 32px 16px;
        opacity: 0.6;
        mat-icon { font-size: 40px; width: 40px; height: 40px; }
        p { margin: 8px 0 0; font-size: 0.85em; }
    }

    .snap-table {
        width: 100%;
        font-size: 0.82em;
        background: transparent;
    }
    .snap-table th, .snap-table td {
        padding: 4px 8px !important;
    }
    .snap-table .num {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }
    .trigger-badge {
        display: inline-block;
        font-size: 0.78em;
        padding: 2px 8px;
        border-radius: 10px;
        background: rgba(255,255,255,0.08);
    }
    .trigger-badge[data-trigger='manual']     { background: rgba(76, 175, 80, 0.18);  color: #4caf50; }
    .trigger-badge[data-trigger='forcePush']  { background: rgba(255, 152, 0, 0.18);  color: #ff9800; }
    .trigger-badge[data-trigger='forcePull']  { background: rgba(33, 150, 243, 0.18); color: #2196f3; }
    .trigger-badge[data-trigger='preRestore'] { background: rgba(156, 39, 176, 0.18); color: #ce93d8; }

    .note-input {
        width: 100%;
        background: transparent;
        border: 1px solid transparent;
        color: inherit;
        font: inherit;
        padding: 4px 6px;
        border-radius: 3px;
        &:hover, &:focus {
            border-color: rgba(255,255,255,0.15);
            background: rgba(255,255,255,0.04);
            outline: none;
        }
    }
    .actions-cell { white-space: nowrap; }
  `]
})
export class AdvancedSyncToolsDialogComponent {
    dialogRef = inject(MatDialogRef<AdvancedSyncToolsDialogComponent>);
    syncService = inject(SyncService);
    state = inject(GameStateService);
    private dialog = inject(DialogService);
    private matDialog = inject(MatDialog);
    private loading = inject(LoadingService);
    private snackBar = inject(MatSnackBar);

    selectedTab = 0;
    snapshots = signal<SnapshotMeta[]>([]);
    loadingList = signal(false);
    busy = signal(false);
    deviceId = computed(() => this.syncService.getDeviceId());

    readonly cols = ['time', 'trigger', 'counts', 'size', 'device', 'note', 'actions'];

    constructor() {
        void this.refreshSnapshots();
    }

    deviceLabel(s: SnapshotMeta): string {
        if (!s.deviceId) return '—';
        const isThis = s.deviceId === this.deviceId();
        const short = s.deviceId.slice(0, 6);
        return isThis ? `${short} (this)` : short;
    }

    formatSize(bytes?: number): string {
        if (bytes === undefined || bytes === null) return '—';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    async refreshSnapshots() {
        this.loadingList.set(true);
        try {
            const list = await this.syncService.listSnapshots();
            list.sort((a, b) => b.createdAt - a.createdAt);
            this.snapshots.set(list);
        } catch (e) {
            console.error('[AdvancedSyncTools] listSnapshots failed', e);
            this.snackBar.open('Failed to list snapshots: ' + this.errMsg(e), 'Close', {
                panelClass: ['snackbar-error']
            });
        } finally {
            this.loadingList.set(false);
        }
    }

    async createManualSnapshot() {
        const note = await this.promptNote('Create Snapshot', '');
        if (note === null) return;

        const proceed = await this.dialog.confirm(
            'Manual snapshots capture the *cloud* state. If this device has ' +
            'unsynced local changes, they will NOT be in the snapshot.\n\n' +
            'Recommendation: run "Sync All" first if you want local changes ' +
            'included. Continue with the snapshot now?',
            'Manual Snapshot',
            'Snapshot now'
        );
        if (!proceed) return;

        this.busy.set(true);
        this.loading.show('Creating snapshot…');
        try {
            await this.syncService.manualSnapshot(note || undefined);
            this.snackBar.open('Snapshot created.', 'OK', { duration: 3000 });
            await this.refreshSnapshots();
        } catch (e) {
            console.error('[AdvancedSyncTools] manualSnapshot failed', e);
            this.snackBar.open('Snapshot failed: ' + this.errMsg(e), 'Close', {
                panelClass: ['snackbar-error']
            });
        } finally {
            this.loading.hide();
            this.busy.set(false);
        }
    }

    async runForcePush() {
        const confirmed = await this.dialog.confirm(
            'FORCE PUSH will make the cloud bucket an exact mirror of this device:\n\n' +
            '  • every cloud book / collection NOT on this device will be DELETED on cloud\n' +
            '  • every local book / collection will be UPLOADED, overwriting the cloud version\n\n' +
            'A snapshot of the current cloud will be taken first so you can restore it.\n\n' +
            'Other devices will lose their version on the next sync. Continue?',
            'Force Push',
            'FORCE PUSH'
        );
        if (!confirmed) return;

        this.busy.set(true);
        try {
            await this.runForcePushCore(false);
            await this.refreshSnapshots();
        } finally {
            this.busy.set(false);
        }
    }

    private async runForcePushCore(skipSnapshot: boolean) {
        // loading.show is scoped to the actual sync call so a
        // SnapshotPreOpError → confirm dialog isn't blocked by a stale
        // overlay. Re-shown on the recursive retry-without-snapshot path.
        this.loading.show('Force pushing to cloud…');
        try {
            const report = await this.syncService.forcePushAll({ skipSnapshot });
            this.loading.hide();
            const summary = `Uploaded: ${report.uploaded}, Removed remote: ${report.deletedRemote}.`;
            if (report.errors.length > 0) {
                console.error('[AdvancedSyncTools] forcePush errors:', report.errors);
                this.snackBar.open(
                    `Force Push had ${report.errors.length} error${report.errors.length === 1 ? '' : 's'} — see console. ${summary}`,
                    'Close',
                    { panelClass: ['snackbar-error'] }
                );
            } else {
                this.snackBar.open(`Force Push done. ${summary}`, 'OK', { duration: 4000 });
            }
        } catch (e) {
            this.loading.hide();
            if (e instanceof SnapshotPreOpError) {
                const continueAnyway = await this.dialog.confirm(
                    `The pre-push safety snapshot failed:\n\n${e.message}\n\n` +
                    'Continue with force push anyway? You will not have a backup of cloud state to restore.',
                    'Snapshot failed',
                    'Continue without snapshot'
                );
                if (continueAnyway) await this.runForcePushCore(true);
                return;
            }
            console.error('[AdvancedSyncTools] forcePush failed', e);
            this.snackBar.open('Force Push failed: ' + this.errMsg(e), 'Close', {
                panelClass: ['snackbar-error']
            });
        }
    }

    async runForcePull() {
        const confirmed = await this.dialog.confirm(
            'FORCE PULL will make this device an exact mirror of the cloud bucket:\n\n' +
            '  • every local book / collection NOT on cloud will be DELETED locally\n' +
            '  • every cloud book / collection will be DOWNLOADED, overwriting the local version\n\n' +
            'A snapshot of this device\'s current state will be taken first so you can restore it.\n\n' +
            'Unsynced local edits not in the snapshot will be lost. Continue?',
            'Force Pull',
            'FORCE PULL'
        );
        if (!confirmed) return;

        this.busy.set(true);
        try {
            await this.runForcePullCore(false);
            await this.refreshSnapshots();
        } finally {
            this.busy.set(false);
        }
    }

    private async runForcePullCore(skipSnapshot: boolean) {
        this.loading.show('Force pulling from cloud…');
        try {
            const report = await this.syncService.forcePullAll({ skipSnapshot });
            this.loading.hide();
            const summary = `Downloaded: ${report.downloaded}, Removed local: ${report.deletedLocal}.`;
            if (report.errors.length > 0) {
                console.error('[AdvancedSyncTools] forcePull errors:', report.errors);
                this.snackBar.open(
                    `Force Pull had ${report.errors.length} error${report.errors.length === 1 ? '' : 's'} — see console. ${summary}`,
                    'Close',
                    { panelClass: ['snackbar-error'] }
                );
            } else {
                this.snackBar.open(`Force Pull done. ${summary}`, 'OK', { duration: 4000 });
            }
        } catch (e) {
            this.loading.hide();
            if (e instanceof SnapshotPreOpError) {
                const continueAnyway = await this.dialog.confirm(
                    `The pre-pull safety snapshot failed:\n\n${e.message}\n\n` +
                    'Continue with force pull anyway? You will not have a backup of local state to restore.',
                    'Snapshot failed',
                    'Continue without snapshot'
                );
                if (continueAnyway) await this.runForcePullCore(true);
                return;
            }
            console.error('[AdvancedSyncTools] forcePull failed', e);
            this.snackBar.open('Force Pull failed: ' + this.errMsg(e), 'Close', {
                panelClass: ['snackbar-error']
            });
        }
    }

    async restore(s: SnapshotMeta) {
        const when = new Date(s.createdAt).toLocaleString();
        const confirmed = await this.dialog.confirm(
            `Restore the snapshot from ${when} (trigger: ${s.trigger})?\n\n` +
            'This will:\n' +
            '  • rewrite the cloud bucket to match the snapshot\n' +
            '  • re-download everything to this device\n' +
            '  • take a preRestore snapshot of the current cloud first (so this is reversible)\n\n' +
            'Other devices will pick up the restored state on their next sync. ' +
            'For best results, ask other devices to pause auto-sync or close the app first. Continue?',
            'Restore Snapshot',
            'Restore'
        );
        if (!confirmed) return;

        this.busy.set(true);
        try {
            await this.runRestoreCore(s, false);
            await this.refreshSnapshots();
        } finally {
            this.busy.set(false);
        }
    }

    private async runRestoreCore(s: SnapshotMeta, skipPreRestoreSnapshot: boolean) {
        this.loading.show('Restoring snapshot…');
        try {
            await this.syncService.restoreSnapshot(s.id, { skipPreRestoreSnapshot });
            this.loading.hide();
            this.snackBar.open(
                'Snapshot restored. Other devices: please trigger Sync All or restart the app to pick up the change.',
                'OK',
                { duration: 8000 }
            );
        } catch (e) {
            this.loading.hide();
            if (e instanceof SnapshotPreOpError) {
                const continueAnyway = await this.dialog.confirm(
                    `The pre-restore safety snapshot failed:\n\n${e.message}\n\n` +
                    'Continue with restore anyway? You will not be able to undo this restore via the safety snapshot.',
                    'Snapshot failed',
                    'Continue without snapshot'
                );
                if (continueAnyway) await this.runRestoreCore(s, true);
                return;
            }
            console.error('[AdvancedSyncTools] restoreSnapshot failed', e);
            this.snackBar.open('Restore failed: ' + this.errMsg(e), 'Close', {
                panelClass: ['snackbar-error']
            });
        }
    }

    async deleteOne(s: SnapshotMeta) {
        const when = new Date(s.createdAt).toLocaleString();
        const confirmed = await this.dialog.confirm(
            `Delete the snapshot from ${when} (trigger: ${s.trigger})? This cannot be undone.`,
            'Delete Snapshot',
            'Delete'
        );
        if (!confirmed) return;

        this.busy.set(true);
        try {
            await this.syncService.deleteSnapshot(s.id);
            this.snapshots.set(this.snapshots().filter(x => x.id !== s.id));
            this.snackBar.open('Snapshot deleted.', 'OK', { duration: 3000 });
        } catch (e) {
            console.error('[AdvancedSyncTools] deleteSnapshot failed', e);
            this.snackBar.open('Delete failed: ' + this.errMsg(e), 'Close', {
                panelClass: ['snackbar-error']
            });
        } finally {
            this.busy.set(false);
        }
    }

    async commitNote(s: SnapshotMeta, ev: Event) {
        const input = ev.target as HTMLInputElement;
        const next = input.value.trim();
        const prev = (s.note ?? '').trim();
        if (next === prev) return;
        try {
            await this.syncService.updateSnapshotNote(s.id, next);
            // Update in-place; avoid full refresh to preserve scroll position.
            this.snapshots.set(this.snapshots().map(x =>
                x.id === s.id ? { ...x, note: next } : x
            ));
        } catch (e) {
            console.error('[AdvancedSyncTools] updateSnapshotNote failed', e);
            this.snackBar.open('Failed to update note: ' + this.errMsg(e), 'Close', {
                panelClass: ['snackbar-error']
            });
            // Revert input value to last-known.
            input.value = prev;
        }
    }

    private async promptNote(title: string, initial: string): Promise<string | null> {
        const ref = this.matDialog.open(SaveNameDialogComponent, {
            data: { title, initialName: initial, placeholder: 'Optional note' } as SaveNameDialogData,
            width: '400px'
        });
        const result = await firstValueFrom(ref.afterClosed());
        if (typeof result !== 'string') return null;
        return result.trim();
    }

    private errMsg(e: unknown): string {
        if (e instanceof Error) return e.message;
        return String(e);
    }
}
