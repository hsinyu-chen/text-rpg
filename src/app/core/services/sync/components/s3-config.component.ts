import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { SyncService } from '../sync.service';
import { S3Config } from '../sync.types';
import {
    S3ConfigJsonDialogComponent,
    S3ConfigJsonDialogData
} from './s3-config-json-dialog.component';

@Component({
    selector: 'app-s3-config',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatFormFieldModule,
        MatInputModule,
        MatButtonModule,
        MatIconModule,
        MatSlideToggleModule,
        MatProgressSpinnerModule,
        MatTooltipModule
    ],
    templateUrl: './s3-config.component.html',
    styleUrl: './s3-config.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class S3ConfigComponent {
    private sync = inject(SyncService);
    private snackBar = inject(MatSnackBar);
    private matDialog = inject(MatDialog);

    endpoint = signal('');
    region = signal('us-east-1');
    bucket = signal('');
    accessKeyId = signal('');
    secretAccessKey = signal('');
    prefix = signal('');
    forcePathStyle = signal(true);
    testing = signal(false);

    autoSync = computed(() => this.sync.autoSyncEnabled().s3);
    s3Configured = computed(() => this.sync.isS3Configured());

    isValid = computed(() => !!(
        this.endpoint().trim() &&
        this.bucket().trim() &&
        this.accessKeyId().trim() &&
        this.secretAccessKey().trim()
    ));

    constructor() {
        const cfg = this.sync.s3Config();
        if (cfg) {
            this.endpoint.set(cfg.endpoint);
            this.region.set(cfg.region || 'us-east-1');
            this.bucket.set(cfg.bucket);
            this.accessKeyId.set(cfg.accessKeyId);
            this.secretAccessKey.set(cfg.secretAccessKey);
            this.prefix.set(cfg.prefix ?? '');
            this.forcePathStyle.set(cfg.forcePathStyle ?? true);
        }
    }

    private buildConfig(): S3Config {
        return {
            endpoint: this.endpoint().trim(),
            region: this.region().trim() || 'us-east-1',
            bucket: this.bucket().trim(),
            accessKeyId: this.accessKeyId().trim(),
            secretAccessKey: this.secretAccessKey().trim(),
            prefix: this.prefix().trim() || undefined,
            forcePathStyle: this.forcePathStyle()
        };
    }

    save(): void {
        if (!this.isValid()) {
            this.snackBar.open('Please fill in all required S3 fields.', 'Close', { duration: 3000 });
            return;
        }
        this.sync.saveS3Config(this.buildConfig());
        this.snackBar.open('S3 configuration saved.', 'OK', { duration: 2000 });
    }

    openExportDialog(): void {
        const json = JSON.stringify(this.buildConfig(), null, 2);
        this.matDialog.open<S3ConfigJsonDialogComponent, S3ConfigJsonDialogData, string | undefined>(
            S3ConfigJsonDialogComponent,
            { data: { mode: 'export', initial: json } }
        );
    }

    async openImportDialog(): Promise<void> {
        const ref = this.matDialog.open<S3ConfigJsonDialogComponent, S3ConfigJsonDialogData, string | undefined>(
            S3ConfigJsonDialogComponent,
            { data: { mode: 'import' } }
        );
        const raw = await firstValueFrom(ref.afterClosed());
        if (!raw) return;

        let parsed: Partial<S3Config>;
        try {
            parsed = JSON.parse(raw) as Partial<S3Config>;
        } catch (e) {
            this.snackBar.open('Invalid JSON: ' + (e as Error).message, 'Close', { duration: 4000 });
            return;
        }
        if (typeof parsed !== 'object' || parsed === null) {
            this.snackBar.open('Config must be a JSON object.', 'Close', { duration: 3000 });
            return;
        }
        if (typeof parsed.endpoint === 'string') this.endpoint.set(parsed.endpoint);
        if (typeof parsed.region === 'string') this.region.set(parsed.region);
        if (typeof parsed.bucket === 'string') this.bucket.set(parsed.bucket);
        if (typeof parsed.accessKeyId === 'string') this.accessKeyId.set(parsed.accessKeyId);
        if (typeof parsed.secretAccessKey === 'string') this.secretAccessKey.set(parsed.secretAccessKey);
        if (typeof parsed.prefix === 'string') this.prefix.set(parsed.prefix);
        if (typeof parsed.forcePathStyle === 'boolean') this.forcePathStyle.set(parsed.forcePathStyle);
        // Auto-persist: the import dialog's Save means "apply", not "fill the form for me to save again".
        if (this.isValid()) {
            this.sync.saveS3Config(this.buildConfig());
            this.snackBar.open('Imported and saved.', 'OK', { duration: 2500 });
        } else {
            this.snackBar.open('Imported. Some required fields are empty — fill them and click Save.', 'Close', { duration: 4000 });
        }
    }

    async toggleAutoSync(on: boolean): Promise<void> {
        if (on) {
            // Don't let users enable auto-sync until creds are confirmed working —
            // otherwise we'd silently rack up failures and disable it again.
            if (!this.s3Configured()) {
                this.snackBar.open('Save and test your S3 connection first.', 'Close', { duration: 3000 });
                return;
            }
            this.testing.set(true);
            try {
                await this.sync.testS3Connection(this.buildConfig());
            } catch (e) {
                this.snackBar.open(
                    'Cannot enable auto-sync: ' + ((e as { message?: string })?.message || 'connection failed'),
                    'Close',
                    { duration: 5000 }
                );
                return;
            } finally {
                this.testing.set(false);
            }
        }
        this.sync.setAutoSyncEnabled('s3', on);
    }

    async testConnection(): Promise<void> {
        if (!this.isValid()) {
            this.snackBar.open('Please fill in all required S3 fields.', 'Close', { duration: 3000 });
            return;
        }
        this.testing.set(true);
        try {
            await this.sync.testS3Connection(this.buildConfig());
            this.snackBar.open('S3 connection OK.', 'OK', { duration: 3000 });
        } catch (e) {
            console.error('[S3Config] Test failed', e);
            this.snackBar.open('S3 connection failed: ' + ((e as { message?: string })?.message || 'Unknown error'), 'Close', { duration: 5000 });
        } finally {
            this.testing.set(false);
        }
    }
}
