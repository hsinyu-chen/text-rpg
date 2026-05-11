import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CORE_MAT } from '@app/shared/material/material-groups';
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
    imports: [...CORE_MAT, MatSlideToggleModule, FormsModule],
    templateUrl: './file-backend-config.component.html',
    styleUrl: './file-backend-config.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class FileBackendConfigComponent {
    permission = inject(FileBackendPermissionService);
    private snackBar = inject(MatSnackBar);
    private sync = inject(SyncService);
    private backends = inject(SyncBackendResolver);

    folderName = computed(() => this.permission.handle()?.name ?? null);

    /** UI label for the permission badge — collapses 'unknown' to 'prompt'
     *  for users (the practical effect is identical: they need to grant). */
    permissionLabel = computed(() => {
        const s = this.permission.permissionState();
        if (s === 'unknown') return 'prompt';
        return s;
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
            this.snackBar.open('Folder bound — File sync ready.', 'OK', { duration: 3000 });
        } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') return;
            console.error('[FileBackendConfig] pickFolder failed', e);
            this.snackBar.open(
                'Failed to bind folder: ' + this.errMsg(e),
                'Close',
                { panelClass: ['snackbar-error'] }
            );
        }
    }

    async unbind(): Promise<void> {
        await this.permission.clear();
        this.sync.setAutoSyncEnabled('file', false);
        this.snackBar.open('Folder unbound.', 'OK', { duration: 2000 });
    }

    /**
     * Manual access test. Useful after a page reload to surface the FSA
     * prompt without committing to a real sync. Runs inside this click
     * handler's user activation so `requestPermission` works.
     */
    async testAccess(): Promise<void> {
        try {
            await this.permission.ensurePermission();
            this.snackBar.open('Folder access OK.', 'OK', { duration: 2000 });
        } catch (e) {
            const msg = e instanceof FileBackendNoHandleError
                ? 'Pick a folder first.'
                : e instanceof FileBackendPermissionDeniedError
                    ? e.message
                    : this.errMsg(e);
            this.snackBar.open('Access failed: ' + msg, 'Close', {
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
                    ? 'Pick a folder first.'
                    : e instanceof FileBackendPermissionDeniedError
                        ? e.message
                        : this.errMsg(e);
                this.snackBar.open('Cannot enable auto-sync: ' + msg, 'Close', {
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
