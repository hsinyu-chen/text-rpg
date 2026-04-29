/**
 * Mark every line that lies inside (or is the delimiter of) a fenced code
 * block (``` / ~~~) so heading-style scans can skip them. Without this, a
 * `# foo` line inside a code fence is mis-treated as an ATX heading,
 * which corrupts outlines, section bounds, and breadcrumb inference.
 *
 * Fence rules per CommonMark: opening up to 3 spaces indent + 3+ same fence
 * chars (info string after is allowed); closing must use the same char and
 * >= the opening length, with trailing whitespace only (no info string).
 * An unclosed fence runs to end-of-document.
 */
export function computeFencedLineMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceChar) {
      mask[i] = true;
      const close = line.match(/^(\s{0,3})([`~]{3,})\s*$/);
      if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }
    const open = line.match(/^(\s{0,3})([`~]{3,})/);
    if (open) {
      mask[i] = true;
      fenceChar = open[2][0];
      fenceLen = open[2].length;
    }
  }
  return mask;
}
