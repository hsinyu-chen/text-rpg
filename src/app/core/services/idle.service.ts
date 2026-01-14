import { Injectable, signal, effect } from '@angular/core';
import { fromEvent, merge, throttleTime, timer, of, filter } from 'rxjs';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { rxResource } from '@angular/core/rxjs-interop';

@Injectable({
    providedIn: 'root',
})
export class IdleService {
    private readonly IDLE_TIME = 5 * 60 * 1000; // 5 minutes

    private showScreensaverSignal = signal(false);
    showScreensaver = this.showScreensaverSignal.asReadonly();

    // Reset signal to trigger the idle resource
    private activitySignal = signal<number>(0);

    // Idle Resource: Automatically manages the timer and reacts to activity
    private idleResource = rxResource({
        params: () => this.activitySignal(),
        stream: () => {
            // If screensaver is already showing, don't start a new timer
            if (this.showScreensaverSignal()) {
                return of(null);
            }
            // Reset 5-minute timer on every activity
            return timer(this.IDLE_TIME).pipe(
                filter(val => val !== null)
            );
        }
    });

    constructor() {
        // Activity detection: updates activitySignal to trigger idleResource reload
        const activityEvents$ = merge(
            fromEvent(window, 'mousemove'),
            fromEvent(window, 'keydown'),
            fromEvent(window, 'mousedown'),
            fromEvent(window, 'touchstart'),
            fromEvent(window, 'wheel')
        ).pipe(
            throttleTime(1000),
            takeUntilDestroyed()
        );

        const activitySignalFromEvents = toSignal(activityEvents$);

        effect(() => {
            // This effect runs whenever activitySignalFromEvents emits (i.e., activity is detected)
            if (activitySignalFromEvents() !== undefined) {
                this.activitySignal.update(v => v + 1);
            }
        });

        // Effect to set screensaver when idleResource emits
        effect(() => {
            if (this.idleResource.value() !== undefined && this.idleResource.value() !== null) {
                this.showScreensaverSignal.set(true);
            }
        });

        // Hotkey listener: Ctrl + Alt + S (強制打開)
        const hotkey$ = fromEvent<KeyboardEvent>(window, 'keydown').pipe(
            filter((event) => event.ctrlKey && event.altKey && (event.key === 's' || event.key === 'S')),
            takeUntilDestroyed()
        );

        const hotkeySignal = toSignal(hotkey$);

        effect(() => {
            const event = hotkeySignal();
            if (event) {
                event.preventDefault();
                this.showScreensaverSignal.set(true);
            }
        });
    }

    closeScreensaver() {
        this.showScreensaverSignal.set(false);
        // Reset activity when closing to start timer fresh
        this.activitySignal.update(v => v + 1);
    }
}
