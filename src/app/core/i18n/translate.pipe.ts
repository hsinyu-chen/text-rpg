import { ChangeDetectorRef, Pipe, type PipeTransform, effect, inject } from '@angular/core';
import { I18nService } from './i18n.service';

type ParamsBag = Record<string, string | number> | undefined;

/**
 * Shallow equality on the param record. Avoids the `JSON.stringify` cost in
 * a `pure: false` pipe that runs every change-detection cycle — params are
 * always shallow `{ key: value }` objects, so a key/length/value walk is
 * strictly cheaper than serializing twice.
 */
function paramsEqual(a: ParamsBag, b: ParamsBag): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        if (a[k] !== b[k]) return false;
    }
    return true;
}

@Pipe({
    name: 'translate',
    standalone: true,
    pure: false,
})
export class TranslatePipe implements PipeTransform {
    private i18n = inject(I18nService);
    private cdr = inject(ChangeDetectorRef);
    private lastKey = '';
    private lastParams: ParamsBag;
    private lastResult = '';

    constructor() {
        effect(() => {
            this.i18n.currentLang();
            if (this.lastKey) {
                const next = this.i18n.translate(this.lastKey, this.lastParams);
                if (next !== this.lastResult) {
                    this.lastResult = next;
                    this.cdr.markForCheck();
                }
            }
        });
    }

    transform(key: string, params?: Record<string, string | number>): string {
        if (!key) return '';
        if (key !== this.lastKey || !paramsEqual(params, this.lastParams)) {
            this.lastKey = key;
            this.lastParams = params;
            this.lastResult = this.i18n.translate(key, params);
        }
        return this.lastResult;
    }
}
