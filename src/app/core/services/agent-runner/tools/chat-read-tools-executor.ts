import type {
    BaseAction,
    ListChatMessagesArgs,
    SearchChatMessagesArgs,
    ReadChatMessageArgs,
    ReadTurnLogsArgs,
    ChatReadField,
    TurnLogKind,
    ToolExecutionResult,
} from '../agent-runner.types';
import type { ChatMessage } from '@app/core/models/types';
import { clampInt } from './tool-helpers';

/**
 * Context subset the chat-read tool executors need. Just the message snapshot
 * — no files, no writes. Save-sim agents pass a visibility-filtered snapshot
 * so the LLM cannot access events outside the entity's visibility set even
 * if it crafts a valid messageId — visibility filtering is enforced at the
 * data layer, not via prompt discipline.
 */
export interface ChatReadContext {
    chatMessages?: ChatMessage[];
}

const NO_CHAT_HISTORY = 'No chat history available. The agent is running outside an in-game session (e.g. world creation mode) or no turns have been played yet.';

/**
 * Dispatcher for the chat-read tool family. Returns null for actions outside
 * this family.
 */
export function dispatchChatReadTool(action: BaseAction, context: ChatReadContext): ToolExecutionResult | null {
    switch (action.action) {
        case 'listChatMessages': return listChatMessages(action.args as ListChatMessagesArgs, context);
        case 'searchChatMessages': return searchChatMessages(action.args as SearchChatMessagesArgs, context);
        case 'readChatMessage': return readChatMessage(action.args as ReadChatMessageArgs, context);
        case 'readTurnLogs': return readTurnLogs(action.args as ReadTurnLogsArgs, context);
        default: return null;
    }
}

function requireChat(context: ChatReadContext): ChatMessage[] | { response: Record<string, unknown> } {
    const msgs = context.chatMessages;
    if (!msgs || msgs.length === 0) return { response: { error: NO_CHAT_HISTORY } };
    return msgs;
}

function logKindToField(kind: TurnLogKind): keyof ChatMessage {
    switch (kind) {
        case 'character': return 'character_log';
        case 'world': return 'world_log';
        case 'inventory': return 'inventory_log';
        case 'quest': return 'quest_log';
    }
}

function listChatMessages(args: ListChatMessagesArgs, context: ChatReadContext): ToolExecutionResult {
    const chat = requireChat(context);
    if (!Array.isArray(chat)) return chat as ToolExecutionResult;

    const limit = clampInt(args.limit, 1, 100, 30);
    const includeHidden = !!args.includeHidden;
    const includeSaves = !!args.includeSaves;

    // Resolve the pagination cursor against unfiltered chat first — otherwise a
    // `before` id that exists but was filtered out (hidden / save-intent) under
    // this call's flags would 404, even though the LLM legitimately got that id
    // from a previous call with different flags. Apply filters AFTER the cut.
    let pool: ChatMessage[] = chat;
    if (args.before) {
        const cutIdx = chat.findIndex(m => m.id === args.before);
        if (cutIdx === -1) {
            return { response: { error: `before id "${args.before}" not found in current chat history` } };
        }
        pool = chat.slice(0, cutIdx);
    }
    if (!includeHidden) pool = pool.filter(m => !m.isHidden);
    if (!includeSaves) pool = pool.filter(m => m.intent !== 'save');

    // Slice the last `limit` chronological messages, then reverse so the
    // result is newest-first — matches the tool docstring ("newest first")
    // and matches the sidebar's intuitive "scroll up = older" mental model
    // the agent reasons with. oldestReturnedId / newestReturnedId flip
    // accordingly.
    const slice = pool.slice(Math.max(0, pool.length - limit)).reverse();
    const filteredCounts = {
        hidden: includeHidden ? 0 : chat.filter(m => m.isHidden).length,
        save: includeSaves ? 0 : chat.filter(m => m.intent === 'save').length,
    };
    const messages = slice.map(m => {
        const hasLogs = !!(m.character_log?.length || m.world_log?.length || m.inventory_log?.length || m.quest_log?.length);
        return {
            id: m.id,
            url: `app://message/${m.id}`,
            role: m.role,
            charCount: (m.content ?? '').length,
            summary: m.summary || undefined,
            intent: m.intent || undefined,
            hasLogs,
        };
    });

    return {
        response: {
            messages,
            returned: messages.length,
            totalVisible: pool.length,
            totalAll: chat.length,
            olderRemaining: pool.length - messages.length,
            oldestReturnedId: messages[messages.length - 1]?.id,
            newestReturnedId: messages[0]?.id,
            filtered: filteredCounts,
        },
    };
}

function searchChatMessages(args: SearchChatMessagesArgs, context: ChatReadContext): ToolExecutionResult {
    const chat = requireChat(context);
    if (!Array.isArray(chat)) return chat as ToolExecutionResult;

    if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
        return { response: { error: 'pattern is required and must be a non-empty string' } };
    }
    let regex: RegExp;
    try {
        regex = new RegExp(args.pattern, args.caseInsensitive ? 'gi' : 'g');
    } catch (e) {
        return { response: { error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` } };
    }

    const scope = args.scope ?? 'content';
    const limit = clampInt(args.limit, 1, 300, 100);
    const contextChars = clampInt(args.contextChars, 0, 400, 80);
    const includeSaves = !!args.includeSaves;
    const PER_MESSAGE_CAP = 3;

    const fieldsForScope: ('content' | 'thought' | 'summary')[] =
        scope === 'all' ? ['content', 'thought', 'summary'] : [scope];

    interface Hit { messageId: string; url: string; role: string; scope: string; snippet: string; matchIndex: number; moreInSameMessage?: number }
    const hits: Hit[] = [];
    let truncated = false;
    let suppressedSaves = 0;

    // Iterate newest-first so limit-hit truncation keeps the most recent
    // matches — aligns with listChatMessages's newest-first convention and
    // matches the chat sidebar's "scroll up = older" mental model. Hidden +
    // save-intent filters still apply per message regardless of direction.
    outer: for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m.isHidden) continue;
        if (!includeSaves && m.intent === 'save') { suppressedSaves++; continue; }
        // Build snippets only up to PER_MESSAGE_CAP; keep counting beyond it so
        // moreInSameMessage reflects the true overflow without paying the
        // string-slice cost for every regex hit on long bodies / broad patterns.
        const perMessageHits: Hit[] = [];
        let totalMessageHits = 0;
        for (const field of fieldsForScope) {
            const raw = (m as unknown as Record<string, unknown>)[field];
            if (typeof raw !== 'string' || raw.length === 0) continue;
            regex.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(raw)) !== null) {
                if (perMessageHits.length < PER_MESSAGE_CAP) {
                    const start = Math.max(0, match.index - contextChars);
                    const end = Math.min(raw.length, match.index + match[0].length + contextChars);
                    const snippet = (start > 0 ? '…' : '') + raw.slice(start, end) + (end < raw.length ? '…' : '');
                    perMessageHits.push({ messageId: m.id, url: `app://message/${m.id}`, role: m.role, scope: field, snippet, matchIndex: match.index });
                }
                totalMessageHits++;
                if (match.index === regex.lastIndex) regex.lastIndex++;
            }
        }
        if (perMessageHits.length === 0) continue;
        if (totalMessageHits > PER_MESSAGE_CAP) {
            const last = perMessageHits[perMessageHits.length - 1];
            perMessageHits[perMessageHits.length - 1] = { ...last, moreInSameMessage: totalMessageHits - PER_MESSAGE_CAP };
        }
        for (const h of perMessageHits) {
            // Limit check BEFORE push, so `truncated` only flips when there's at
            // least one keep entry we genuinely cannot include. A pump that fills
            // hits to exactly `limit` on the last available hit ends the outer
            // loop naturally (no more matching messages → no re-entry of this
            // inner block) and truncated stays false.
            if (hits.length >= limit) { truncated = true; break outer; }
            hits.push(h);
        }
    }

    const notes: string[] = [];
    if (truncated) notes.push(`Stopped at limit=${limit}; at least one further match was not returned. Raise limit or narrow the pattern.`);
    if (suppressedSaves > 0) notes.push(`${suppressedSaves} save-intent turn(s) skipped (administrative file-update turns). Pass includeSaves:true to include them.`);

    return {
        response: {
            hits,
            count: hits.length,
            truncated,
            suppressedSaves: suppressedSaves > 0 ? suppressedSaves : undefined,
            note: notes.length ? notes.join(' ') : undefined,
        },
    };
}

function readChatMessage(args: ReadChatMessageArgs, context: ChatReadContext): ToolExecutionResult {
    const chat = requireChat(context);
    if (!Array.isArray(chat)) return chat as ToolExecutionResult;

    const ids = args.messageIds;
    if (!Array.isArray(ids) || ids.length === 0) {
        return { response: { error: 'messageIds must be a non-empty array' } };
    }

    const allowed: ChatReadField[] = ['content', 'thought', 'logs', 'analysis', 'summary', 'intent'];
    const include = (args.include && args.include.length > 0)
        ? args.include.filter(f => allowed.includes(f))
        : ['content' as ChatReadField];

    interface Result {
        id: string;
        url: string;
        role?: string;
        content?: string;
        thought?: string;
        analysis?: string;
        summary?: string;
        intent?: string;
        logs?: {
            character?: string[];
            world?: string[];
            inventory?: string[];
            quest?: string[];
        };
        error?: string;
    }

    const byId = new Map(chat.map(m => [m.id, m]));
    const results: Result[] = ids.map(id => {
        const m = byId.get(id);
        if (!m) return { id, url: `app://message/${id}`, error: 'Message not found' };
        const r: Result = { id, url: `app://message/${id}`, role: m.role };
        for (const f of include) {
            if (f === 'logs') {
                const logs: Result['logs'] = {};
                if (m.character_log?.length) logs.character = m.character_log;
                if (m.world_log?.length) logs.world = m.world_log;
                if (m.inventory_log?.length) logs.inventory = m.inventory_log;
                if (m.quest_log?.length) logs.quest = m.quest_log;
                r.logs = logs;
            } else {
                const v = (m as unknown as Record<string, unknown>)[f];
                if (typeof v === 'string' && v.length > 0) {
                    (r as unknown as Record<string, unknown>)[f] = v;
                }
            }
        }
        return r;
    });

    return { response: { messages: results } };
}

function readTurnLogs(args: ReadTurnLogsArgs, context: ChatReadContext): ToolExecutionResult {
    const chat = requireChat(context);
    if (!Array.isArray(chat)) return chat as ToolExecutionResult;

    const kindList: TurnLogKind[] = (args.kinds && args.kinds.length > 0)
        ? args.kinds
        : ['character', 'world', 'inventory', 'quest'];

    let pool: ChatMessage[];
    if (args.messageIds && args.messageIds.length > 0) {
        const byId = new Map(chat.map(m => [m.id, m]));
        pool = [];
        const missing: string[] = [];
        for (const id of args.messageIds) {
            const m = byId.get(id);
            if (m) pool.push(m); else missing.push(id);
        }
        if (missing.length) {
            return { response: { error: `Message id(s) not found: ${missing.join(', ')}` } };
        }
    } else {
        const recent = clampInt(args.recent, 1, 100, 20);
        pool = chat.slice(Math.max(0, chat.length - recent));
    }

    interface Group { messageId: string; role: string; kind: TurnLogKind; entries: string[] }
    const groups: Group[] = [];
    for (const m of pool) {
        for (const kind of kindList) {
            const entries = m[logKindToField(kind)] as string[] | undefined;
            if (entries && entries.length > 0) {
                groups.push({ messageId: m.id, role: m.role, kind, entries });
            }
        }
    }

    return {
        response: {
            groups,
            count: groups.length,
            scanned: pool.length,
            note: groups.length === 0 ? 'No log entries found in the scanned range — none of those turns wrote to character_log / world_log / inventory_log / quest_log.' : undefined,
        },
    };
}
