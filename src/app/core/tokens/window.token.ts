import { InjectionToken, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';

export const WINDOW = new InjectionToken<Window & typeof globalThis>('WINDOW', {
    providedIn: 'root',
    factory: () => {
        const win = inject(DOCUMENT).defaultView;
        if (!win) throw new Error('WINDOW token: defaultView is unavailable (non-browser environment).');
        return win as Window & typeof globalThis;
    },
});
