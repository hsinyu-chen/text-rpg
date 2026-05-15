import type { MatDialogConfig } from '@angular/material/dialog';

/**
 * Sizing preset for full-screen `mat-dialog` instances that also carry the
 * global `.fullscreen-dialog` panelClass styling. The CSS rule already pins
 * `width/height: 100% !important` on `.fullscreen-dialog`, so these inline
 * dimensions are technically redundant — but Material treats unspecified
 * `width/height` as "auto", which can flash before the global CSS applies
 * during dialog open. Keep them in the open() config to lock the size
 * synchronously, and consume this shared constant so the literal isn't
 * duplicated across every caller (chat-input, agent-console, etc.).
 */
export const FULLSCREEN_DIALOG_CONFIG = {
  width: '100%',
  height: '100%',
  maxWidth: '100%',
  maxHeight: '100%',
  panelClass: 'fullscreen-dialog',
} as const satisfies Partial<MatDialogConfig>;
