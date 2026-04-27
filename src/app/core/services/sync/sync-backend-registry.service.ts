import { Injectable, Type } from '@angular/core';
import { SyncBackendId } from './sync.types';

export interface SyncBackendDef {
    label: string;
    description?: string;
    configComponent: Type<unknown>;
    /**
     * Optional gate to disable the radio entry (e.g. Drive needs a Client ID).
     */
    isAvailable?: () => boolean;
}

export interface SyncBackendDefEntry extends SyncBackendDef {
    id: SyncBackendId;
}

/**
 * Plug-in registry for sync provider UI components.
 * Mirrors the LLMProviderRegistry.registerUIComponent pattern from the
 * monorepo: backends register a config component class, the host
 * dialog renders the active one via NgComponentOutlet.
 */
@Injectable({ providedIn: 'root' })
export class SyncBackendRegistry {
    private defs = new Map<SyncBackendId, SyncBackendDef>();

    register(id: SyncBackendId, def: SyncBackendDef): void {
        this.defs.set(id, def);
    }

    list(): SyncBackendDefEntry[] {
        return Array.from(this.defs.entries()).map(([id, d]) => ({ id, ...d }));
    }

    get(id: SyncBackendId): SyncBackendDef | null {
        return this.defs.get(id) ?? null;
    }

    getConfigComponent(id: SyncBackendId): Type<unknown> | null {
        return this.defs.get(id)?.configComponent ?? null;
    }
}
