/**
 * Whether `value` is a CSS color the browser accepts — any CSS Color 4 syntax
 * (`#hex` / a name / `rgb()` / `hsl()` / `oklch()` / …). Used to gate a
 * user-supplied stat-chip color before binding it as a custom property so an
 * invalid value can't break the `color-mix` that derives the chip's tint.
 *
 * In a non-browser context (unit env) where `CSS.supports` is unavailable, the
 * value is accepted — the browser is the final arbiter at render time.
 */
export function isValidCssColor(value: string | undefined | null): value is string {
  if (!value) return false;
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return true;
  return CSS.supports('color', value);
}
