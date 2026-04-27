import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { SyncProviderConfigComponent } from '../../core/services/sync/components/sync-provider-config.component';

@Component({
    selector: 'app-sync-provider-dialog',
    standalone: true,
    imports: [
        CommonModule,
        MatDialogModule,
        MatButtonModule,
        SyncProviderConfigComponent
    ],
    templateUrl: './sync-provider-dialog.component.html',
    styleUrl: './sync-provider-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class SyncProviderDialogComponent {}
