import type { AgentLogEntry } from '../services/agent-runner/agent-runner.types';

/**
 * One labelled trace block: an agent's log entries plus optionally the file
 * snapshot it was operating against. Multi-section input lets the multi-agent
 * save pipeline copy every advanced agent's trace in one shot.
 */
export interface AgentDebugLogSection {
    /** Heading shown above the section (e.g. `AGENT` for the main file-agent, or an advanced-save agent's display name). */
    title: string;
    logs: readonly AgentLogEntry[];
    /** Working file snapshot. Omit for sections that aren't tied to a file set (e.g. save-side advanced agents whose KB is the chat-side engine's). */
    files?: ReadonlyMap<string, string>;
}

const SEPARATOR = '─'.repeat(60);

/**
 * Renders one or more `AgentDebugLogSection`s into the plain-text format
 * `AgentConsole`'s copy-debug button has emitted since day one. Format is
 * load-bearing — testers paste this into bug reports and grep it — so any
 * future change should bump a version marker rather than silently reshape.
 */
export function formatAgentDebugLog(sections: readonly AgentDebugLogSection[]): string {
    const lines: string[] = [];
    for (const section of sections) {
        lines.push(`=== ${section.title} LOG ===`, '');
        section.logs.forEach((log, i) => {
            const prefix = log.role === 'user' ? 'USER' : log.role === 'model' ? 'MODEL' : 'SYSTEM';
            const tag = log.isToolCall ? ` [TOOL CALL: ${log.toolName ?? ''}]`
                : log.isToolResult ? ` [TOOL RESULT: ${log.toolName ?? ''}]`
                : '';
            lines.push(`[${i + 1}] ${prefix}${tag}`);
            if (log.thought) lines.push(`<thinking>\n${log.thought}\n</thinking>`);
            if (log.text) lines.push(log.text);
            lines.push('');
        });
        if (section.files) {
            lines.push('', `=== ${section.title} FILE CONTENTS (current in-memory state) ===`, '');
            section.files.forEach((content, name) => {
                lines.push(SEPARATOR, `FILE: ${name}`, SEPARATOR);
                lines.push(content, '');
            });
        }
    }
    return lines.join('\n');
}
