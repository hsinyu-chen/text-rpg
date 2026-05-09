import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { I18nService } from './i18n.service';

@Directive({
    // eslint-disable-next-line @angular-eslint/directive-selector
    selector: '[translate]',
    standalone: true,
})
export class TranslateDirective {
    key = input<string>('', { alias: 'translate' });
    translateParams = input<Record<string, string | number> | undefined>();

    private el = inject(ElementRef<HTMLElement>);
    private i18n = inject(I18nService);

    constructor() {
        effect(() => {
            this.i18n.currentLang();
            this.updateText();
        });
    }

    private updateText(): void {
        const k = this.key();
        if (!k) return;
        this.el.nativeElement.textContent = this.i18n.translate(k, this.translateParams());
    }
}
