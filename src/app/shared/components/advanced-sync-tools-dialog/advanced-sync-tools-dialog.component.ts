import { Component, inject, signal } from '@angular/core';
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

import { SyncService } from '@app/core/services/sync/sync.service';
import { SyncBackendResolver } from '@app/core/services/sync/sync-backend-resolver.service';
import { SnapshotService, SnapshotPreOpError } from '@app/core/services/sync/snapshot.service';
import { SnapshotMeta } from '@app/core/services/sync/sync.types';
import { DialogService } from '@app/core/services/dialog.service';
import { LoadingService } from '@app/core/services/loading.service';
import { GameStateService } from '@app/core/services/game-state.service';
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
    templateUrl: './advanced-sync-tools-dialog.component.html',
    styleUrl: './advanced-sync-tools-dialog.component.scss'
})
export class AdvancedSyncToolsDialogComponent {
    dialogRef = inject(MatDialogRef<AdvancedSyncToolsDialogComponent>);
    syncService = inject(SyncService);
    syncBackends = inject(SyncBackendResolver);
    private snapshotService = inject(SnapshotService);
    state = inject(GameStateService);
    private dialog = inject(DialogService);
    private matDialog = inject(MatDialog);
    private loading = inject(LoadingService);
    private snackBar = inject(MatSnackBar);

    selectedTab = 0;
    snapshots = signal<SnapshotMeta[]>([]);
    loadingList = signal(false);
    busy = signal(false);
    // computed() would imply reactivity, but getDeviceId() reads localStorage
    // once and never changes within a session — a plain field is the right shape.
    readonly deviceId = this.snapshotService.getDeviceId();
    /**
     * Per-snapshot guard: which ids currently have a note PUT in flight.
     * Prevents the rare keystroke pattern (Enter → blur → re-focus → blur)
     * from firing concurrent updateSnapshotNote requests for the same id
     * while the body of `commitNote` is still awaiting the network round-trip.
     */
    private notesInFlight = new Set<string>();

    readonly cols = ['time', 'trigger', 'counts', 'size', 'device', 'note', 'actions'];

    constructor() {
        void this.refreshSnapshots();
    }

    deviceLabel(s: SnapshotMeta): string {
        if (!s.deviceId) return '—';
        const isThis = s.deviceId === this.deviceId;
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
            const list = await this.snapshotService.listSnapshots();
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
            await this.snapshotService.manualSnapshot(note || undefined);
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
            await this.snapshotService.deleteSnapshot(s.id);
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
        if (this.notesInFlight.has(s.id)) return;
        this.notesInFlight.add(s.id);
        try {
            await this.snapshotService.updateSnapshotNote(s.id, next);
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
        } finally {
            this.notesInFlight.delete(s.id);
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
