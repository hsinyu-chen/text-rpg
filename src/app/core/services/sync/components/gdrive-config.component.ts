/* eslint-disable no-restricted-syntax -- TODO(dom-cleanup): migrate window.location.origin to inject(WINDOW) */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { GoogleDriveService } from '../../google-drive.service';

@Component({
    selector: 'app-gdrive-config',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatButtonModule,
        MatIconModule,
        MatFormFieldModule,
        MatInputModule
    ],
    templateUrl: './gdrive-config.component.html',
    styleUrl: './gdrive-config.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class GDriveConfigComponent {
    drive = inject(GoogleDriveService);
    private snackBar = inject(MatSnackBar);
    private clipboard = inject(Clipboard);

    clientId = signal<string>(this.drive.getOAuthClientIdSnapshot());
    redirectUri = window.location.origin;

    showInputs = computed(() => this.drive.isUserConfigurable);

    status = computed(() => {
        if (!this.drive.isConfigured) return 'unconfigured';
        return this.drive.isAuthenticated() ? 'authenticated' : 'unauthenticated';
    });

    canSave = computed(() => this.clientId().trim().length > 0);

    async signIn(): Promise<void> {
        try {
            await this.drive.login();
        } catch (e) {
            console.error('[GDriveConfig] Sign-in failed', e);
        }
    }

    save(): void {
        this.drive.saveOAuthClientId(this.clientId());
        this.snackBar.open('OAuth Client ID saved. Sign in again to apply.', 'OK', { duration: 3000 });
    }

    copyRedirectUri(): void {
        if (this.clipboard.copy(this.redirectUri)) {
            this.snackBar.open('Redirect URI copied.', 'OK', { duration: 1500 });
        }
    }
}
