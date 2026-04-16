/**
 * Utility to convert common LaTeX mathematical sequences to plain-text/Unicode equivalents.
 * Used during session export and auto-save to ensure compatibility with non-LaTeX viewers.
 */
/**
 * Repairs LaTeX sequences that were corrupted by improper unescaping 
 * (e.g., \rightarrow becoming [CR]ightarrow).
 */
export function repairCorruptedLatex(text: string): string {
    if (!text) return text;
    
    // 1. Fix 'Lost R' or 'Unescaped Control' corruption globally
    // We target anything starting with $ or \ followed by specialized suffixes
    let repaired = text
        .replace(/([\\$])[\r\n\t\0\s]*ightarrow/g, '$1rightarrow')
        .replace(/([\\$])[\r\n\t\0\s]*ewline/g, '$1newline')
        .replace(/([\\$])[\r\n\t\s]*ext\{/g, '$1text{');
        
    // 2. Ensure every command has a backslash
    repaired = repaired.replace(/([$])\s*(rightarrow|Rightarrow|leftarrow|Leftarrow|leftrightarrow|Leftrightarrow)/g, '$1\\$2');
    
    // 3. Cleanup double backslashes that might have been introduced during earlier steps or repair
    repaired = repaired.replace(/\\\\rightarrow/g, '\\rightarrow')
                       .replace(/\\\\newline/g, '\\newline')
                       .replace(/\\\\text\{/g, '\\text{');

    return repaired;
}

export function convertLatexToSymbols(text: string): string {
    if (!text) return text;

    // Repair any corruption first
    let result = repairCorruptedLatex(text);

    // Map of common LaTeX sequences to their Unicode equivalents
    const latexMap: Record<string, string> = {
        '\\\\rightarrow': '→',
        '\\\\Rightarrow': '⇒',
        '\\\\leftarrow': '←',
        '\\\\Leftarrow': '⇐',
        '\\\\leftrightarrow': '↔',
        '\\\\Leftrightarrow': '⇔',
        '\\\\uparrow': '↑',
        '\\\\downarrow': '↓',
        '\\\\infty': '∞',
        '\\\\approx': '≈',
        '\\\\neq': '≠',
        '\\\\le': '≤',
        '\\\\ge': '≥',
        '\\\\pm': '±',
        '\\\\times': '×',
        '\\\\div': '÷',
        '\\\\bullet': '•',
        '\\\\cdot': '·',
        '\\\\degree': '°',
        // Add more as needed
    };

    // Handle inline math: $...$

    // Handle inline math: $...$
    // Note: We only replace if it matches exactly a mapped symbol wrapped in math delimiters,
    // or if the symbol appears without delimiters but with the backslash.
    
    // First, handle symbols wrapped in dollar signs: $\rightarrow$ or $ \rightarrow $
    for (const [latex, symbol] of Object.entries(latexMap)) {
        // Regex to match $ latex $ with optional whitespace
        const mathPattern = new RegExp(`\\$\\s*${latex}\\s*\\$`, 'g');
        result = result.replace(mathPattern, symbol);
        
        // Also handle symbols without dollar signs but with backslashes (some models might omit $)
        const rawPattern = new RegExp(latex, 'g');
        result = result.replace(rawPattern, symbol);
    }

    // Clean up any remaining double backslashes if any escaped ones were left
    // (This is a safety measure)
    return result;
}
