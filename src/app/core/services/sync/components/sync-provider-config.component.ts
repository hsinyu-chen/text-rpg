import { ChangeDetectionStrategy, Component, computed, inject, Type } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatRadioModule } from '@angular/material/radio';
import { TranslatePipe } from '@app/core/i18n';
import { SyncService } from '../sync.service';
import { SyncBackendRegistry } from '../sync-backend-registry.service';
import { SyncBackendResolver } from '../sync-backend-resolver.service';
import { SyncBackendId } from '../sync.types';

@Component({
    selector: 'app-sync-provider-config',
    standalone: true,
    imports: [FormsModule, MatRadioModule, NgComponentOutlet, TranslatePipe],
    templateUrl: './sync-provider-config.component.html',
    styleUrl: './sync-provider-config.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class SyncProviderConfigComponent {
    private sync = inject(SyncService);
    private registry = inject(SyncBackendRegistry);
    private resolver = inject(SyncBackendResolver);

    backends = computed(() => this.registry.list());
    selectedId = this.resolver.activeBackendId;

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
