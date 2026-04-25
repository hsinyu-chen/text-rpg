export interface ContentViolation {
  type: string;
  line: number;
  snippet: string;
}

// Known LaTeX command names. A backslash followed by any of these is flagged.
// Intentionally covers math, Greek, arrows, fonts, environments — not prose commands
// like \textbf that some markdown renderers support.
const LATEX_CMDS = new Set([
  // Arrows
  'rightarrow','leftarrow','Rightarrow','Leftarrow','uparrow','downarrow',
  'leftrightarrow','Leftrightarrow','nearrow','searrow','nwarrow','swarrow',
  'to','mapsto','hookrightarrow','hookleftarrow','implies','iff','Longrightarrow',
  'longrightarrow','Longleftarrow','longleftarrow','longleftrightarrow',
  // Greek lowercase
  'alpha','beta','gamma','delta','epsilon','varepsilon','zeta','eta','theta',
  'vartheta','iota','kappa','lambda','mu','nu','xi','pi','varpi','rho',
  'varrho','sigma','varsigma','tau','upsilon','phi','varphi','chi','psi','omega',
  // Greek uppercase
  'Gamma','Delta','Theta','Lambda','Xi','Pi','Sigma','Upsilon','Phi','Psi','Omega',
  // Math structures
  'frac','dfrac','tfrac','cfrac','sqrt','sum','int','oint','iint','iiint',
  'prod','coprod','lim','limsup','liminf','sup','inf','max','min',
  // Trig / functions
  'log','ln','exp','sin','cos','tan','sec','csc','cot',
  'arcsin','arccos','arctan','sinh','cosh','tanh','det','dim','ker',
  // Math symbols
  'infty','partial','nabla','forall','exists','nexists','emptyset','varnothing',
  'cdot','cdots','ldots','vdots','ddots','hdots','times','div','pm','mp',
  'oplus','ominus','otimes','oslash','odot','circ','bullet','star',
  'dagger','ddagger','wp','aleph','hbar',
  // Relations
  'leq','geq','neq','approx','equiv','sim','simeq','cong','propto','asymp',
  'subset','supset','subseteq','supseteq','subsetneq','supsetneq',
  'in','notin','ni','cap','cup','sqcup','sqcap','vee','wedge','setminus',
  'perp','parallel','mid','nmid',
  // Fonts / decorators
  'mathbb','mathbf','mathrm','mathit','mathcal','mathsf','mathtt','mathfrak',
  'boldsymbol','operatorname',
  // Accents
  'overline','underline','hat','widehat','tilde','widetilde','bar','vec',
  'dot','ddot','dddot','acute','grave','check','breve','mathring',
  'overrightarrow','overleftarrow','overbrace','underbrace',
  // Environments
  'begin','end',
  // Sizing
  'left','right',
]);

/**
 * Scan content for LaTeX formatting. Returns a list of violations found.
 *
 * Detection strategy (no naïve global regex):
 *   1. `$$` — always display math
 *   2. `\(` `\)` `\[` `\]` — always math delimiters
 *   3. `\commandname` — checked against LATEX_CMDS whitelist
 *   4. `$...$` — character scanner finds matched pairs, then applies
 *      semantic checks to avoid false-positives like $100 or $varName
 */
export function detectLatexViolations(content: string): ContentViolation[] {
  const violations: ContentViolation[] = [];
  const lines = content.split('\n');

  for (let idx = 0; idx < lines.length; idx++) {
    const v = scanLine(lines[idx], idx + 1);
    if (v) violations.push(v);
  }

  return violations;
}

function scanLine(line: string, lineNum: number): ContentViolation | null {
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (ch === '\\') {
      const next = line[i + 1];

      // Math delimiters \( \) \[ \]
      if (next === '(' || next === ')' || next === '[' || next === ']') {
        return { type: `LaTeX delimiter \\${next}`, line: lineNum, snippet: snip(line, i, i + 2) };
      }

      // Extract alphabetic command name
      let j = i + 1;
      while (j < line.length && isAlpha(line[j])) j++;

      if (j > i + 1) {
        const cmd = line.slice(i + 1, j);
        if (LATEX_CMDS.has(cmd)) {
          return { type: `LaTeX \\${cmd}`, line: lineNum, snippet: snip(line, i, j) };
        }
        i = j;
      } else {
        i += 2;
      }
      continue;
    }

    if (ch === '$') {
      // Display math $$
      if (line[i + 1] === '$') {
        return { type: 'LaTeX display math $$', line: lineNum, snippet: snip(line, i, i + 2) };
      }

      // Scan for closing $ on same line
      let j = i + 1;
      while (j < line.length && line[j] !== '$') j++;

      if (j < line.length) {
        const inner = line.slice(i + 1, j);
        if (isMathLike(inner)) {
          return { type: 'LaTeX inline math $...$', line: lineNum, snippet: snip(line, i, j + 1) };
        }
        i = j + 1;
      } else {
        i++;
      }
      continue;
    }

    i++;
  }

  return null;
}

/**
 * Returns true only when the content between two $ signs looks like a LaTeX
 * math expression — not currency ($100), not a bare identifier ($name).
 */
function isMathLike(inner: string): boolean {
  const t = inner.trim();
  if (!t || t.length === 0) return false;

  // Currency: digits, optional commas/decimals — $100 $1,234 $3.14
  if (/^\d[\d,]*(\.\d+)?$/.test(t)) return false;

  // Simple identifier: $name $var_name — common in prose or templates
  if (/^[a-zA-Z_]\w*$/.test(t)) return false;

  // Contains backslash → LaTeX command inside math mode
  if (t.includes('\\')) return true;

  // Superscript / subscript followed by a character or brace
  if (/[_^][{a-zA-Z0-9]/.test(t)) return true;

  return false;
}

function isAlpha(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function snip(line: string, start: number, end: number): string {
  const MAX = 60;
  const from = Math.max(0, start - 10);
  const to = Math.min(line.length, end + 10);
  const s = line.slice(from, to);
  return s.length > MAX ? s.slice(0, MAX) + '…' : s;
}

/** Build an error result to return when violations are detected. */
export function latexViolationError(
  violations: ContentViolation[],
  fieldLabel: string
): { error: string } {
  const shown = violations.slice(0, 5);
  const rest = violations.length - shown.length;
  const lines = shown.map(v => `  line ${v.line}: ${v.type} — "${v.snippet}"`);
  if (rest > 0) lines.push(`  … and ${rest} more`);
  return {
    error:
      `[Format error] "${fieldLabel}" contains LaTeX formatting. ` +
      `Use plain text symbols instead (e.g. → not \\rightarrow, × not \\times, ² not ^{2}).\n` +
      lines.join('\n')
  };
}
