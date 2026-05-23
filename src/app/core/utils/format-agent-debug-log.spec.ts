import { describe, expect, it } from 'vitest';
import type { AgentLogEntry } from '../services/agent-runner/agent-runner.types';
import { formatAgentDebugLog } from './format-agent-debug-log';

function entry(partial: Partial<AgentLogEntry>): AgentLogEntry {
    return {
        role: 'user',
        text: '',
        type: 'info',
        ...partial,
    };
}

describe('formatAgentDebugLog', () => {
    it('renders a single section with role-tagged numbered entries', () => {
        const out = formatAgentDebugLog([{
            title: 'AGENT',
            logs: [
                entry({ role: 'user', text: 'hi' }),
                entry({ role: 'model', text: 'sup', type: 'model' }),
            ],
        }]);
        expect(out).toContain('=== AGENT LOG ===');
        expect(out).toMatch(/\[1\] USER\nhi/);
        expect(out).toMatch(/\[2\] MODEL\nsup/);
    });

    it('emits the [TOOL CALL: name] / [TOOL RESULT: name] tags', () => {
        const out = formatAgentDebugLog([{
            title: 'AGENT',
            logs: [
                entry({ role: 'model', text: 'args', isToolCall: true, toolName: 'grep' }),
                entry({ role: 'system', text: 'result', isToolResult: true, toolName: 'grep' }),
            ],
        }]);
        expect(out).toContain('[1] MODEL [TOOL CALL: grep]');
        expect(out).toContain('[2] SYSTEM [TOOL RESULT: grep]');
    });

    it('wraps thought text in a <thinking>...</thinking> block before the visible text', () => {
        const out = formatAgentDebugLog([{
            title: 'AGENT',
            logs: [entry({ role: 'model', thought: 'why', text: 'because' })],
        }]);
        // thought block must come first, then the message body
        const idxThought = out.indexOf('<thinking>\nwhy\n</thinking>');
        const idxText = out.indexOf('because');
        expect(idxThought).toBeGreaterThan(-1);
        expect(idxText).toBeGreaterThan(idxThought);
    });

    it('includes the FILE CONTENTS block when files are present, omits when not', () => {
        const withFiles = formatAgentDebugLog([{
            title: 'AGENT',
            logs: [entry({ role: 'user', text: 'hi' })],
            files: new Map([['a.md', 'A body']]),
        }]);
        expect(withFiles).toContain('=== AGENT FILE CONTENTS (current in-memory state) ===');
        expect(withFiles).toContain('FILE: a.md');
        expect(withFiles).toContain('A body');

        const withoutFiles = formatAgentDebugLog([{
            title: 'AGENT',
            logs: [entry({ role: 'user', text: 'hi' })],
        }]);
        expect(withoutFiles).not.toContain('FILE CONTENTS');
    });

    it('concatenates multiple sections, each with its own title', () => {
        const out = formatAgentDebugLog([
            { title: 'MAIN', logs: [entry({ role: 'user', text: 'a' })] },
            { title: 'INVENTORY', logs: [entry({ role: 'model', text: 'b' })] },
        ]);
        expect(out).toContain('=== MAIN LOG ===');
        expect(out).toContain('=== INVENTORY LOG ===');
        const idxMain = out.indexOf('=== MAIN LOG ===');
        const idxInv = out.indexOf('=== INVENTORY LOG ===');
        expect(idxMain).toBeLessThan(idxInv);
    });
});
