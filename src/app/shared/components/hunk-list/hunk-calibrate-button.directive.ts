import { Directive, TemplateRef, inject } from '@angular/core';
import { FileUpdate } from '@app/core/services/file-update.types';

/** Render context handed to a consumer-supplied calibrate-button template. */
export interface HunkCalibrateButtonContext {
  /** The hunk this button acts on. */
  $implicit: FileUpdate;
  /** True while this hunk is the one currently being calibrated. */
  active: boolean;
  /** Start calibration for this hunk; swallows the row-select click. */
  trigger: (event?: Event) => void;
}

/**
 * Marks an `<ng-template>` a host passes into {@link HunkListComponent} to
 * replace the default calibrate button — each host picks its own icon / tooltip
 * while the list keeps ownership of the calibration action (handed in via the
 * template context's `trigger`).
 */
@Directive({
  selector: 'ng-template[appHunkCalibrateButton]',
  standalone: true,
})
export class HunkCalibrateButtonDirective {
  readonly templateRef = inject<TemplateRef<HunkCalibrateButtonContext>>(TemplateRef);

  static ngTemplateContextGuard(
    _directive: HunkCalibrateButtonDirective,
    _context: unknown,
  ): _context is HunkCalibrateButtonContext {
    return true;
  }
}
