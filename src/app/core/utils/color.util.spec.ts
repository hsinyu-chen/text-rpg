import { describe, expect, it } from 'vitest';
import { isValidCssColor } from './color.util';

describe('isValidCssColor', () => {
  it('rejects empty / nullish values', () => {
    expect(isValidCssColor('')).toBe(false);
    expect(isValidCssColor(undefined)).toBe(false);
    expect(isValidCssColor(null)).toBe(false);
  });

  // A real CSS color passes in either env: when CSS.supports exists it validates
  // true, and when it's absent (unit env) the function accepts any non-empty
  // string. (Invalid-color rejection is only asserted where CSS.supports exists,
  // so it's left out here to stay env-robust.)
  it('accepts valid CSS colors', () => {
    expect(isValidCssColor('dodgerblue')).toBe(true);
    expect(isValidCssColor('#3aa')).toBe(true);
    expect(isValidCssColor('rgb(10 20 30)')).toBe(true);
  });
});
