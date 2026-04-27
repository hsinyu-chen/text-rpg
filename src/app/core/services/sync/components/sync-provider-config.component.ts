import { ChangeDetectionStrategy, Component, computed, inject, Type } from '@angular/core';
import { CommonModule, NgComponentOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatRadioModule } from '@angular/material/radio';
import { SyncService } from '../sync.service';
import { SyncBackendRegistry } from '../sync-backend-registry.service';
import { SyncBackendId } from '../sync.types';

@Component({
    selector: 'app-sync-provider-config',
    standalone: true,
    imports: [CommonModule, FormsModule, MatRadioModule, NgComponentOutlet],
    templateUrl: './sync-provider-config.component.html',
    styleUrl: './sync-provider-config.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class SyncProviderConfigComponent {
    private sync = inject(SyncService);
    private registry = inject(SyncBackendRegistry);

    backends = computed(() => this.registry.list());
    selectedId = this.sync.activeBackendId;

    activeConfigComponent = computed<Type<unknown> | null>(() =>
        this.registry.getConfigComponent(this.selectedId())
    );

    onBackendChange(id: SyncBackendId): void {
        this.sync.setActiveBackend(id);
    }

    isAvailable(entry: { isAvailable?: () => boolean }): boolean {
        return entry.isAvailable ? entry.isAvailable() : true;
    }
}
