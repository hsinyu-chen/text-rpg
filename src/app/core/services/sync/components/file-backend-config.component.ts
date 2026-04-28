import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
    FileBackendPermissionService,
    FileBackendNoHandleError,
    FileBackendPermissionDeniedError
} from '../file-backend-permission.service';

@Component({
    selector: 'app-file-backend-config',
    standalone: true,
    imports: [CommonModule, MatButtonModule, MatIconModule],
    templateUrl: './file-backend-config.component.html',
    styleUrl: './file-backend-config.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class FileBackendConfigComponent {
    permission = inject(FileBackendPermissionService);
    private snackBar = inject(MatSnackBar);

    folderName = computed(() => this.permission.handle()?.name ?? null);

    /** UI label for the permission badge — collapses 'unknown' to 'prompt'
     *  for users (the practical effect is identical: they need to grant). */
    permissionLabel = computed(() => {
        const s = this.permission.permissionState();
        if (s === 'unknown') return 'prompt';
        return s;
    });

    async pickFolder(): Promise<void> {
        try {
            await this.permission.pickFolder();
            this.snackBar.open('Folder bound — File sync ready.', 'OK', { duration: 3000 });
        } catch (e) {
            // AbortError when the user cancels the picker — silent.
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

    private errMsg(e: unknown): string {
        if (e instanceof Error) return e.message;
        return String(e);
    }
}
