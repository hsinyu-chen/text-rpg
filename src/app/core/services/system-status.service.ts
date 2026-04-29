import { Injectable, computed, inject, signal, DestroyRef } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { WINDOW } from '../tokens/window.token';

interface BatteryManager extends EventTarget {
    readonly charging: boolean;
    readonly level: number;
}

interface BatteryNavigator {
    getBattery?: () => Promise<BatteryManager>;
}

/**
 * Surfaces the bits of system status normally visible in the OS status bar
 * (clock, battery) so they can be shown inside the app — relevant when the
 * PWA is installed in fullscreen display mode and the OS bar is hidden.
 *
 * Battery Status API is only available on Chromium-based browsers (Chrome,
 * Edge, Android Chrome). iOS Safari and Firefox don't expose it, in which
 * case batteryLevel stays null and the UI should hide that pill.
 */
@Injectable({ providedIn: 'root' })
export class SystemStatusService {
    private win = inject(WINDOW);
    private doc = inject(DOCUMENT);
    private destroyRef = inject(DestroyRef);

    private readonly nowMs = signal(Date.now());
    private readonly batteryLevelRaw = signal<number | null>(null);
    private readonly batteryChargingRaw = signal(false);

    /**
     * True when running inside an installed PWA window (standalone / fullscreen
     * / minimal-ui). In a regular browser tab the OS / browser already shows
     * the clock + battery, so callers can choose to hide the in-app pills.
     */
    readonly inPwaWindow = signal(false);

    readonly timeText = computed(() => {
        const d = new Date(this.nowMs());
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    });

    readonly batteryAvailable = computed(() => this.batteryLevelRaw() !== null);

    readonly batteryText = computed(() => {
        const lvl = this.batteryLevelRaw();
        return lvl === null ? '' : `${Math.round(lvl * 100)}%`;
    });

    /** Material icon name reflecting current charge + charging state. */
    readonly batteryIcon = computed(() => {
        const lvl = this.batteryLevelRaw();
        if (lvl === null) return 'battery_unknown';
        if (this.batteryChargingRaw()) return 'battery_charging_full';
        if (lvl >= 0.95) return 'battery_full';
        if (lvl >= 0.80) return 'battery_6_bar';
        if (lvl >= 0.65) return 'battery_5_bar';
        if (lvl >= 0.50) return 'battery_4_bar';
        if (lvl >= 0.35) return 'battery_3_bar';
        if (lvl >= 0.20) return 'battery_2_bar';
        if (lvl >= 0.10) return 'battery_1_bar';
        return 'battery_alert';
    });

    constructor() {
        this.startClock();
        this.startVisibilityResync();
        this.startBattery();
        this.detectDisplayMode();
    }

    private startClock(): void {
        // Align ticks to the next minute boundary so the displayed HH:MM flips
        // on the actual minute change instead of drifting by up to 30s.
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = () => {
            this.nowMs.set(Date.now());
            const ms = 60_000 - (Date.now() % 60_000);
            timer = setTimeout(tick, ms);
        };
        tick();
        this.destroyRef.onDestroy(() => {
            if (timer !== null) clearTimeout(timer);
        });
    }

    private startVisibilityResync(): void {
        // setTimeout drifts (or is suspended) when the page is hidden — refresh
        // immediately on return so the clock isn't stale after unlocking.
        const onVis = () => {
            if (this.doc.visibilityState === 'visible') this.nowMs.set(Date.now());
        };
        this.doc.addEventListener('visibilitychange', onVis);
        this.destroyRef.onDestroy(() => this.doc.removeEventListener('visibilitychange', onVis));
    }

    private startBattery(): void {
        const nav = this.win.navigator as Navigator & BatteryNavigator;
        if (typeof nav.getBattery !== 'function') return;
        nav.getBattery().then(bat => {
            const sync = () => {
                this.batteryLevelRaw.set(bat.level);
                this.batteryChargingRaw.set(bat.charging);
            };
            sync();
            bat.addEventListener('levelchange', sync);
            bat.addEventListener('chargingchange', sync);
            this.destroyRef.onDestroy(() => {
                bat.removeEventListener('levelchange', sync);
                bat.removeEventListener('chargingchange', sync);
            });
        }).catch(() => { /* permission denied or unsupported — leave null */ });
    }

    private detectDisplayMode(): void {
        const mq = this.win.matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)');
        this.inPwaWindow.set(mq.matches);
        const onChange = (e: MediaQueryListEvent) => this.inPwaWindow.set(e.matches);
        mq.addEventListener('change', onChange);
        this.destroyRef.onDestroy(() => mq.removeEventListener('change', onChange));
    }
}
