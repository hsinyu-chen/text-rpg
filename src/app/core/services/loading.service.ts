import { Injectable, inject } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { LoadingState } from './loading.state';
import { LoadingOverlayComponent } from '../../shared/components/loading-overlay/loading-overlay.component';

@Injectable({
    providedIn: 'root'
})
export class LoadingService {
    private overlay = inject(Overlay);
    private state = inject(LoadingState);
    private overlayRef: OverlayRef | null = null;

    // Bridge for existing components that use these signals directly
    isLoading = this.state.isLoading;
    message = this.state.message;

    show(msg = 'Loading...') {
        this.state.message.set(msg);
        if (this.state.isLoading()) return;

        this.state.isLoading.set(true);

        if (!this.overlayRef) {
            this.overlayRef = this.overlay.create({
                hasBackdrop: false,
                positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
                scrollStrategy: this.overlay.scrollStrategies.block()
            });
        }

        if (!this.overlayRef.hasAttached()) {
            this.overlayRef.attach(new ComponentPortal(LoadingOverlayComponent));
        }
    }

    hide() {
        this.state.isLoading.set(false);
        if (this.overlayRef) {
            this.overlayRef.detach();
            this.overlayRef = null;
        }
    }
}
