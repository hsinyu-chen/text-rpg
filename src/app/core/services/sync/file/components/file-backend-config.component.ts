import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { SyncService } from '../../sync.service';
import { SyncBackendResolver } from '../../sync-backend-resolver.service';
import {
    FileBackendPermissionService,
    FileBackendNoHandleError,
    FileBackendPermissionDeniedError
} from '../file-backend-permission.service';

@Component({
    selector: 'app-file-backend-config',
    standalone: true,
    imports: [...CORE_MAT, MatSlideToggleModule, FormsModule, TranslatePipe],
    templateUrl: './file-backend-config.component.html',
    styleUrl: './file-backend-config.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class FileBackendConfigComponent {
    permission = inject(FileBackendPermissionService);
    private snackBar = inject(MatSnackBar);
    private sync = inject(SyncService);
    private backends = inject(SyncBackendResolver);
    private i18n = inject(I18nService);

    folderName = computed(() => this.permission.handle()?.name ?? null);

    /** Raw permission state used for the [data-state] attribute (kept as
     *  the FSA enum so CSS selectors don't change). Collapses 'unknown' to
     *  'prompt' since the practical effect is identical: user needs to grant. */
    permissionStateKey = computed<'granted' | 'denied' | 'prompt'>(() => {
        const s = this.permission.permissionState();
        return s === 'unknown' ? 'prompt' : s;
    });

    /** Translated label for the permission badge text. */
    permissionLabel = computed(() => {
        const key = this.permissionStateKey();
        const dictKey = key === 'granted' ? 'sync.file.permissionStateGranted'
            : key === 'denied' ? 'sync.file.permissionStateDenied'
            : 'sync.file.permissionStatePrompt';
        return this.i18n.translate(dictKey);
    });

    autoSync = computed(() => this.backends.autoSyncEnabled().file);

    /** Auto-sync only works while permission is 'granted' (Chromium persistent
     *  grant, or fresh transient grant). Block the toggle otherwise so the
     *  user can't enable something that silently won't run. */
    canEnableAutoSync = computed(() =>
        this.permission.handle() !== null
        && this.permission.permissionState() === 'granted'
    );

    async pickFolder(): Promise<void> {
        try {
            await this.permission.pickFolder();
            this.snackBar.open(this.i18n.translate('sync.file.folderBoundSuccess'), this.i18n.translate('dialog.ok'), { duration: 3000 });
        } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') return;
            console.error('[FileBackendConfig] pickFolder failed', e);
            this.snackBar.open(
                this.i18n.translate('sync.file.bindFolderFailedPrefix') + this.errMsg(e),
                this.i18n.translate('ui.CLOSE'),
                { panelClass: ['snackbar-error'] }
            );
        }
    }

    async unbind(): Promise<void> {
        await this.permission.clear();
        this.sync.setAutoSyncEnabled('file', false);
        this.snackBar.open(this.i18n.translate('sync.file.folderUnboundSuccess'), this.i18n.translate('dialog.ok'), { duration: 2000 });
    }

    /**
     * Manual access test. Useful after a page reload to surface the FSA
     * prompt without committing to a real sync. Runs inside this click
     * handler's user activation so `requestPermission` works.
     */
    async testAccess(): Promise<void> {
        try {
            await this.permission.ensurePermission();
            this.snackBar.open(this.i18n.translate('sync.file.folderAccessOK'), this.i18n.translate('dialog.ok'), { duration: 2000 });
        } catch (e) {
            const msg = e instanceof FileBackendNoHandleError
                ? this.i18n.translate('sync.file.pickFolderFirst')
                : e instanceof FileBackendPermissionDeniedError
                    ? e.message
                    : this.errMsg(e);
            this.snackBar.open(this.i18n.translate('sync.file.accessFailedPrefix') + msg, this.i18n.translate('ui.CLOSE'), {
                panelClass: ['snackbar-error']
            });
        }
    }

    async toggleAutoSync(on: boolean): Promise<void> {
        if (on) {
            // Confirm permission inside this click's user activation —
            // if FSA only granted a transient (not persistent) grant the
            // first sync would fail and trip the circuit breaker.
            try {
                await this.permission.ensurePermission();
            } catch (e) {
                const msg = e instanceof FileBackendNoHandleError
                    ? this.i18n.translate('sync.file.pickFolderFirst')
                    : e instanceof FileBackendPermissionDeniedError
                        ? e.message
                        : this.errMsg(e);
                this.snackBar.open(this.i18n.translate('sync.file.cannotEnableAutoSyncPrefix') + msg, this.i18n.translate('ui.CLOSE'), {
                    duration: 5000,
                    panelClass: ['snackbar-error']
                });
                return;
            }
        }
        this.sync.setAutoSyncEnabled('file', on);
    }

    private errMsg(e: unknown): string {
        if (e instanceof Error) return e.message;
        return String(e);
    }
}
