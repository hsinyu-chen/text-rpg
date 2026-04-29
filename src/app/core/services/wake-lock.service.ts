import { Injectable, effect, inject, DestroyRef } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { WINDOW } from '../tokens/window.token';
import { GameStateService } from './game-state.service';

interface WakeLockSentinelLike {
    released: boolean;
    release: () => Promise<void>;
    addEventListener: (type: 'release', listener: () => void) => void;
}

interface WakeLockNavigator {
    wakeLock?: {
        request: (type: 'screen') => Promise<WakeLockSentinelLike>;
    };
}

@Injectable({ providedIn: 'root' })
export class WakeLockService {
    private state = inject(GameStateService);
    private destroyRef = inject(DestroyRef);
    private doc = inject(DOCUMENT);
    private win = inject(WINDOW);

    private sentinel: WakeLockSentinelLike | null = null;
    private want = false;

    constructor() {
        effect(() => {
            this.want = this.state.status() === 'generating';
            if (this.want) {
                void this.acquire();
            } else {
                void this.release();
            }
        });

        // Wake Lock auto-releases when the page is hidden; re-acquire on return
        // if we still want it (i.e. generation is still in flight).
        const onVisibility = () => {
            if (this.want && this.doc.visibilityState === 'visible') {
                void this.acquire();
            }
        };
        this.doc.addEventListener('visibilitychange', onVisibility);
        this.destroyRef.onDestroy(() => {
            this.doc.removeEventListener('visibilitychange', onVisibility);
            void this.release();
        });
    }

    private async acquire(): Promise<void> {
        if (this.sentinel && !this.sentinel.released) return;
        const nav = this.win.navigator as Navigator & WakeLockNavigator;
        if (!nav.wakeLock) return;
        try {
            const lock = await nav.wakeLock.request('screen');
            lock.addEventListener('release', () => {
                if (this.sentinel === lock) this.sentinel = null;
            });
            this.sentinel = lock;
        } catch {
            // Permission denied, page hidden, or unsupported — fail quiet.
        }
    }

    private async release(): Promise<void> {
        const lock = this.sentinel;
        this.sentinel = null;
        if (!lock || lock.released) return;
        try {
            await lock.release();
        } catch {
            // ignore
        }
    }
}
