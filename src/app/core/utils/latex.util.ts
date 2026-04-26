export interface ContentViolation {
  type: string;
  line: number;
  snippet: string;
}

// ── Unicode map ────────────────────────────────────────────────────────────────

export const LATEX_TO_UNICODE: Record<string, string> = {
  // Arrows
  rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
  uparrow: '↑', downarrow: '↓', leftrightarrow: '↔', Leftrightarrow: '⇔',
  to: '→', mapsto: '↦', implies: '⟹', iff: '⟺',
  Longrightarrow: '⟹', longrightarrow: '⟶', Longleftarrow: '⟸',
  nearrow: '↗', searrow: '↘', nwarrow: '↖', swarrow: '↙',
  // Math ops
  times: '×', div: '÷', pm: '±', mp: '∓',
  cdot: '·', circ: '∘', bullet: '•', star: '★',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘', odot: '⊙',
  // Relations
  leq: '≤', geq: '≥', neq: '≠', approx: '≈', equiv: '≡',
  sim: '∼', simeq: '≃', cong: '≅', propto: '∝', asymp: '≍',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  subsetneq: '⊊', supsetneq: '⊋',
  in: '∈', notin: '∉', ni: '∋',
  cap: '∩', cup: '∪', sqcup: '⊔', sqcap: '⊓', setminus: '∖',
  perp: '⊥', parallel: '∥', mid: '∣', nmid: '∤',
  vee: '∨', wedge: '∧',
  // Logic / sets
  forall: '∀', exists: '∃', nexists: '∄',
  emptyset: '∅', varnothing: '∅',
  // Calculus / analysis
  infty: '∞', partial: '∂', nabla: '∇',
  int: '∫', oint: '∮', sum: '∑', prod: '∏',
  sqrt: '√', lim: 'lim', sup: 'sup', inf: 'inf',
  // Greek lowercase
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // Greek uppercase
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // Dots / misc
  ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  hbar: 'ℏ', aleph: 'ℵ', wp: '℘',
  dagger: '†', ddagger: '‡',
};

// Commands with no Unicode equivalent — detected as violations but not replaceable.
const LATEX_CMDS_NO_UNICODE = [
  'frac','dfrac','tfrac','cfrac','iint','iiint','coprod',
  'limsup','liminf','max','min',
  'log','ln','exp','sin','cos','tan','sec','csc','cot',
  'arcsin','arccos','arctan','sinh','cosh','tanh','det','dim','ker',
  'hdots','hookrightarrow','hookleftarrow','longleftrightarrow',
  'mathbb','mathbf','mathrm','mathit','mathcal','mathsf','mathtt','mathfrak',
  'boldsymbol','operatorname',
  'overline','underline','hat','widehat','tilde','widetilde','bar','vec',
  'dot','ddot','dddot','acute','grave','check','breve','mathring',
  'overrightarrow','overleftarrow','overbrace','underbrace',
  'begin','end','left','right',
];

// Full detection set: everything in LATEX_TO_UNICODE plus commands without Unicode equivalents.
export const LATEX_CMDS = new Set([...Object.keys(LATEX_TO_UNICODE), ...LATEX_CMDS_NO_UNICODE]);

// ── Sanitization ───────────────────────────────────────────────────────────────

function replaceLatexCmds(s: string): string {
  return s.replace(/\\([a-zA-Z]+)/g, (m, cmd) => LATEX_TO_UNICODE[cmd] ?? m);
}

/** Replace LaTeX expressions in plain text with Unicode equivalents. */
export function sanitizeLatexToUnicode(text: string): string {
  return text
    .replace(/\$\\([a-zA-Z]+)\$/g, (m, cmd) => LATEX_TO_UNICODE[cmd] ?? m)
    .replace(/\$\$([^$]*)\$\$/g, (_, inner) => replaceLatexCmds(inner))
    .replace(/\\\(([^]*?)\\\)/g, (_, inner) => replaceLatexCmds(inner))
    .replace(/\\\[([^]*?)\\\]/g, (_, inner) => replaceLatexCmds(inner))
    .replace(/\\([a-zA-Z]+)/g, (m, cmd) => LATEX_TO_UNICODE[cmd] ?? m);
}

/** Repairs LaTeX sequences corrupted by improper unescaping (e.g. \r in \rightarrow). */
export function repairCorruptedLatex(text: string): string {
  if (!text) return text;
  return text
    .replace(/([\\$])[\r\n\t\0\s]*ightarrow/g, '$1rightarrow')
    .replace(/([\\$])[\r\n\t\0\s]*ewline/g, '$1newline')
    .replace(/([\\$])[\r\n\t\s]*ext\{/g, '$1text{')
    .replace(/([$])\s*(rightarrow|Rightarrow|leftarrow|Leftarrow|leftrightarrow|Leftrightarrow)/g, '$1\\$2')
    .replace(/\\\\rightarrow/g, '\\rightarrow')
    .replace(/\\\\newline/g, '\\newline')
    .replace(/\\\\text\{/g, '\\text{');
}

/** Repair corruption then convert LaTeX to Unicode. Backward-compatible wrapper for session/export use. */
export function convertLatexToSymbols(text: string): string {
  if (!text) return text;
  return sanitizeLatexToUnicode(repairCorruptedLatex(text));
}

// ── Detection / validation ─────────────────────────────────────────────────────

/**
 * Scan content for LaTeX formatting. Returns a list of violations found.
 *
 * Detection strategy:
 *   1. `$$` — always display math
 *   2. `\(` `\)` `\[` `\]` — always math delimiters
 *   3. `\commandname` — checked against LATEX_CMDS
 *   4. `$...$` — character scanner, semantic checks to avoid false-positives ($100, $varName)
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
      if (next === '(' || next === ')' || next === '[' || next === ']') {
        return { type: `LaTeX delimiter \\${next}`, line: lineNum, snippet: snip(line, i, i + 2) };
      }
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
      if (line[i + 1] === '$') {
        return { type: 'LaTeX display math $$', line: lineNum, snippet: snip(line, i, i + 2) };
      }
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

function isMathLike(inner: string): boolean {
  const t = inner.trim();
  if (!t) return false;
  if (/^\d[\d,]*(\.\d+)?$/.test(t)) return false;
  if (/^[a-zA-Z_]\w*$/.test(t)) return false;
  if (t.includes('\\')) return true;
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

// ── KaTeX rendering helpers ────────────────────────────────────────────────────

// Excludes $...$ — LLM output frequently has stray dollar signs (currency, artifacts).
// Only $$...$$, \(...\), and \[...\] are recognized.
export const KATEX_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '\\[', right: '\\]', display: true },
];

export function hasKatexDelimiters(text: string | undefined | null): boolean {
  if (!text) return false;
  return text.includes('$$') || text.includes('\\(') || text.includes('\\[');
}
