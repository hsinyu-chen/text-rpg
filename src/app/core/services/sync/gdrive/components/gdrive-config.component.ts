import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { WINDOW } from '@app/core/tokens/window.token';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { GoogleOAuthService } from '@app/core/services/google-oauth.service';
import { I18nService, TranslatePipe } from '@app/core/i18n';

@Component({
    selector: 'app-gdrive-config',
    standalone: true,
    imports: [
        FormsModule,
        MatButtonModule,
        MatIconModule,
        MatFormFieldModule,
        MatInputModule,
        TranslatePipe
    ],
    templateUrl: './gdrive-config.component.html',
    styleUrl: './gdrive-config.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class GDriveConfigComponent {
    oauth = inject(GoogleOAuthService);
    private snackBar = inject(MatSnackBar);
    private clipboard = inject(Clipboard);
    private readonly win = inject(WINDOW);
    private i18n = inject(I18nService);

    clientId = signal<string>(this.oauth.getOAuthClientIdSnapshot());
    redirectUri = this.win.location.origin;

    showInputs = computed(() => this.oauth.isUserConfigurable);

    status = computed(() => {
        if (!this.oauth.isConfigured) return 'unconfigured';
        return this.oauth.isAuthenticated() ? 'authenticated' : 'unauthenticated';
    });

    canSave = computed(() => this.clientId().trim().length > 0);

    async signIn(): Promise<void> {
        try {
            await this.oauth.login();
        } catch (e) {
            console.error('[GDriveConfig] Sign-in failed', e);
        }
    }

    save(): void {
        this.oauth.saveOAuthClientId(this.clientId());
        this.snackBar.open(this.i18n.translate('sync.gdrive.oauthSavedSnackbar'), this.i18n.translate('dialog.ok'), { duration: 3000 });
    }

    copyRedirectUri(): void {
        if (this.clipboard.copy(this.redirectUri)) {
            this.snackBar.open(this.i18n.translate('sync.gdrive.redirectCopiedSnackbar'), this.i18n.translate('dialog.ok'), { duration: 1500 });
        }
    }
}
