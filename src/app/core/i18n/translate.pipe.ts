import { ChangeDetectorRef, Pipe, type PipeTransform, effect, inject } from '@angular/core';
import { I18nService } from './i18n.service';

@Pipe({
    name: 'translate',
    standalone: true,
    pure: false,
})
export class TranslatePipe implements PipeTransform {
    private i18n = inject(I18nService);
    private cdr = inject(ChangeDetectorRef);
    private lastKey = '';
    private lastParams: Record<string, string | number> | undefined;
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
        if (key !== this.lastKey || JSON.stringify(params) !== JSON.stringify(this.lastParams)) {
            this.lastKey = key;
            this.lastParams = params;
            this.lastResult = this.i18n.translate(key, params);
        }
        return this.lastResult;
    }
}
