import { Directive, TemplateRef, inject, input } from '@angular/core';
import { FileUpdate } from '@app/core/services/file-update.types';

/** Render context handed to a consumer-supplied calibrate-button template. */
export interface HunkCalibrateContext {
  /** The hunk this button acts on. */
  $implicit: FileUpdate;
  /** True while this hunk is the one currently being calibrated. */
  active: boolean;
  /** Start calibration for this hunk; swallows the row-select click. */
  trigger: (event?: Event) => void;
}

/**
 * Per-host customization of {@link HunkListComponent}'s calibration affordance.
 * The marked `<ng-template>` replaces the default calibrate button (the list
 * keeps ownership of the action, handed back via the context's `trigger`); the
 * optional `*Key` inputs override the calibration panel's title / confirm /
 * cancel labels, letting a host reframe "calibrate a failed match" as "edit a
 * patch". Hosts that don't apply the directive keep the default wording + icon.
 */
@Directive({
  selector: 'ng-template[appHunkCalibrate]',
  standalone: true,
})
export class HunkCalibrateDirective {
  readonly templateRef = inject<TemplateRef<HunkCalibrateContext>>(TemplateRef);

  /** i18n keys overriding the panel labels; unset → the default calibrate wording. */
  titleKey = input<string>();
  confirmKey = input<string>();
  cancelKey = input<string>();

  static ngTemplateContextGuard(
    _directive: HunkCalibrateDirective,
    _context: unknown,
  ): _context is HunkCalibrateContext {
    return true;
  }
}
