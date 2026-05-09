import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTableModule } from '@angular/material/table';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CORE_MAT } from '@app/shared/material/material-groups';
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
import { I18nService, TranslatePipe } from '@app/core/i18n';

@Component({
    selector: 'app-advanced-sync-tools-dialog',
    standalone: true,
    imports: [
        ...CORE_MAT,
        MatDialogModule,
        MatTabsModule,
        MatTableModule,
        MatProgressSpinnerModule,
        FormsModule,
        DatePipe,
        TranslatePipe
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
    private i18n = inject(I18nService);

    private t(key: string, params?: Record<string, string | number>): string {
        return this.i18n.translate(`dialog.${key}`, params);
    }

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
            this.snackBar.open(this.t('failedListSnapshots') + this.errMsg(e), this.i18n.translate('ui.CLOSE'), {
                panelClass: ['snackbar-error']
            });
        } finally {
            this.loadingList.set(false);
        }
    }

    async createManualSnapshot() {
        const note = await this.promptNote(this.t('createSnapshot'), '');
        if (note === null) return;

        const proceed = await this.dialog.confirm(
            this.t('manualSnapshotBody'),
            this.t('manualSnapshotTitle'),
            this.t('manualSnapshotConfirmBtn'),
        );
        if (!proceed) return;

        this.busy.set(true);
        this.loading.show(this.t('creatingSnapshotMessage'));
        try {
            await this.snapshotService.manualSnapshot(note || undefined);
            this.snackBar.open(this.t('snapshotCreated'), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
            await this.refreshSnapshots();
        } catch (e) {
            console.error('[AdvancedSyncTools] manualSnapshot failed', e);
            this.snackBar.open(this.t('snapshotFailed') + this.errMsg(e), this.i18n.translate('ui.CLOSE'), {
                panelClass: ['snackbar-error']
            });
        } finally {
            this.loading.hide();
            this.busy.set(false);
        }
    }

    async runForcePush() {
        const confirmed = await this.dialog.confirm(
            this.t('forcePushDialogBody'),
            this.t('forcePushDialogTitle'),
            this.t('forcePushDialogConfirmBtn'),
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
        this.loading.show(this.t('forcePushingMessage'));
        try {
            const report = await this.syncService.forcePushAll({ skipSnapshot });
            this.loading.hide();
            if (report.errors.length > 0) {
                console.error('[AdvancedSyncTools] forcePush errors:', report.errors);
                this.snackBar.open(
                    this.t('forcePushErrorSummary', {
                        count: report.errors.length,
                        uploaded: report.uploaded,
                        deletedRemote: report.deletedRemote,
                    }),
                    this.i18n.translate('ui.CLOSE'),
                    { panelClass: ['snackbar-error'] }
                );
            } else {
                this.snackBar.open(
                    this.t('forcePushDoneSummary', {
                        uploaded: report.uploaded,
                        deletedRemote: report.deletedRemote,
                    }),
                    this.i18n.translate('ui.CLOSE'),
                    { duration: 4000 },
                );
            }
        } catch (e) {
            this.loading.hide();
            if (e instanceof SnapshotPreOpError) {
                const continueAnyway = await this.dialog.confirm(
                    this.t('snapshotPushFailedBody', { error: e.message }),
                    this.t('snapshotPreOpFailedTitle'),
                    this.t('snapshotPreOpContinueBtn'),
                );
                if (continueAnyway) await this.runForcePushCore(true);
                return;
            }
            console.error('[AdvancedSyncTools] forcePush failed', e);
            this.snackBar.open(this.t('forcePushFailed') + this.errMsg(e), this.i18n.translate('ui.CLOSE'), {
                panelClass: ['snackbar-error']
            });
        }
    }

    async runForcePull() {
        const confirmed = await this.dialog.confirm(
            this.t('forcePullDialogBody'),
            this.t('forcePullDialogTitle'),
            this.t('forcePullDialogConfirmBtn'),
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
        this.loading.show(this.t('forcePullingMessage'));
        try {
            const report = await this.syncService.forcePullAll({ skipSnapshot });
            this.loading.hide();
            if (report.errors.length > 0) {
                console.error('[AdvancedSyncTools] forcePull errors:', report.errors);
                this.snackBar.open(
                    this.t('forcePullErrorSummary', {
                        count: report.errors.length,
                        downloaded: report.downloaded,
                        deletedLocal: report.deletedLocal,
                    }),
                    this.i18n.translate('ui.CLOSE'),
                    { panelClass: ['snackbar-error'] }
                );
            } else {
                this.snackBar.open(
                    this.t('forcePullDoneSummary', {
                        downloaded: report.downloaded,
                        deletedLocal: report.deletedLocal,
                    }),
                    this.i18n.translate('ui.CLOSE'),
                    { duration: 4000 },
                );
            }
        } catch (e) {
            this.loading.hide();
            if (e instanceof SnapshotPreOpError) {
                const continueAnyway = await this.dialog.confirm(
                    this.t('snapshotPullFailedBody', { error: e.message }),
                    this.t('snapshotPreOpFailedTitle'),
                    this.t('snapshotPreOpContinueBtn'),
                );
                if (continueAnyway) await this.runForcePullCore(true);
                return;
            }
            console.error('[AdvancedSyncTools] forcePull failed', e);
            this.snackBar.open(this.t('forcePullFailed') + this.errMsg(e), this.i18n.translate('ui.CLOSE'), {
                panelClass: ['snackbar-error']
            });
        }
    }

    async restore(s: SnapshotMeta) {
        const when = new Date(s.createdAt).toLocaleString();
        const confirmed = await this.dialog.confirm(
            this.t('restoreSnapshotBody', { when, trigger: s.trigger }),
            this.t('restoreSnapshotTitle'),
            this.t('restoreSnapshotConfirmBtn'),
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
        this.loading.show(this.t('restoringMessage'));
        try {
            await this.syncService.restoreSnapshot(s.id, { skipPreRestoreSnapshot });
            this.loading.hide();
            this.snackBar.open(
                this.t('snapshotRestoredMessage'),
                this.i18n.translate('ui.CLOSE'),
                { duration: 8000 }
            );
        } catch (e) {
            this.loading.hide();
            if (e instanceof SnapshotPreOpError) {
                const continueAnyway = await this.dialog.confirm(
                    this.t('snapshotRestoreFailedBody', { error: e.message }),
                    this.t('snapshotPreOpFailedTitle'),
                    this.t('snapshotPreOpContinueBtn'),
                );
                if (continueAnyway) await this.runRestoreCore(s, true);
                return;
            }
            console.error('[AdvancedSyncTools] restoreSnapshot failed', e);
            this.snackBar.open(this.t('restoreFailed') + this.errMsg(e), this.i18n.translate('ui.CLOSE'), {
                panelClass: ['snackbar-error']
            });
        }
    }

    async deleteOne(s: SnapshotMeta) {
        const when = new Date(s.createdAt).toLocaleString();
        const confirmed = await this.dialog.confirm(
            this.t('deleteSnapshotBody', { when, trigger: s.trigger }),
            this.t('deleteSnapshotTitle'),
            this.t('delete'),
        );
        if (!confirmed) return;

        this.busy.set(true);
        try {
            await this.snapshotService.deleteSnapshot(s.id);
            this.snapshots.set(this.snapshots().filter(x => x.id !== s.id));
            this.snackBar.open(this.t('snapshotDeleted'), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
        } catch (e) {
            console.error('[AdvancedSyncTools] deleteSnapshot failed', e);
            this.snackBar.open(this.t('deleteFailed') + this.errMsg(e), this.i18n.translate('ui.CLOSE'), {
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
            this.snackBar.open(this.t('failedUpdateNote') + this.errMsg(e), this.i18n.translate('ui.CLOSE'), {
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
            data: { title, initialName: initial, placeholder: this.t('optionalNote') } as SaveNameDialogData,
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
