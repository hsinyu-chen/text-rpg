import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/**
 * Focuses the host input on mount and selects its current text. Used for
 * inline editors that appear when a user clicks "edit" on an item — replaces
 * the older pattern of having a service reach into the DOM via querySelector
 * after a setTimeout.
 */
@Directive({
    selector: 'input[appAutofocusSelect]',
    standalone: true,
})
export class AutofocusSelectDirective {
    private el = inject<ElementRef<HTMLInputElement>>(ElementRef);

    constructor() {
        afterNextRender(() => {
            const input = this.el.nativeElement;
            input.focus();
            input.select();
        });
    }
}
