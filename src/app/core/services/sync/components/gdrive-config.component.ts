import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
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

    private snapshot = this.drive.getOAuthCredsSnapshot();

    clientId = signal<string>(this.snapshot.clientId);
    clientIdTauri = signal<string>(this.snapshot.clientIdTauri);
    clientSecretTauri = signal<string>(this.snapshot.clientSecretTauri);

    redirectUri = typeof window !== 'undefined' ? window.location.origin : '';

    showInputs = computed(() => this.drive.isUserConfigurable);
    isTauri = this.drive.isTauriRuntime;

    status = computed(() => {
        if (!this.drive.isConfigured) return 'unconfigured';
        if (this.isTauri && !this.drive.isTauriConfigured) return 'tauri-incomplete';
        return this.drive.isAuthenticated() ? 'authenticated' : 'unauthenticated';
    });

    canSave = computed(() => {
        const id = this.clientId().trim();
        if (!id) return false;
        if (this.isTauri) {
            return this.clientIdTauri().trim().length > 0;
        }
        return true;
    });

    async signIn(): Promise<void> {
        try {
            await this.drive.login();
        } catch (e) {
            console.error('[GDriveConfig] Sign-in failed', e);
        }
    }

    save(): void {
        this.drive.saveOAuthCreds({
            clientId: this.clientId(),
            clientIdTauri: this.clientIdTauri(),
            clientSecretTauri: this.clientSecretTauri()
        });
        this.snackBar.open('OAuth credentials saved. Sign in again to apply.', 'OK', { duration: 3000 });
    }

    async copyRedirectUri(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.redirectUri);
            this.snackBar.open('Redirect URI copied.', 'OK', { duration: 1500 });
        } catch {
            // clipboard unavailable — silently ignore; the value is visible in the UI
        }
    }
}
