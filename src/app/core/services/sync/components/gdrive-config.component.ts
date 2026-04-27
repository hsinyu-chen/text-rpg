import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { GoogleDriveService } from '../../google-drive.service';

@Component({
    selector: 'app-gdrive-config',
    standalone: true,
    imports: [CommonModule, MatButtonModule, MatIconModule],
    templateUrl: './gdrive-config.component.html',
    styleUrl: './gdrive-config.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class GDriveConfigComponent {
    drive = inject(GoogleDriveService);

    status = computed(() => {
        if (!this.drive.isConfigured) return 'unconfigured';
        return this.drive.isAuthenticated() ? 'authenticated' : 'unauthenticated';
    });

    async signIn(): Promise<void> {
        try {
            await this.drive.login();
        } catch (e) {
            console.error('[GDriveConfig] Sign-in failed', e);
        }
    }
}
