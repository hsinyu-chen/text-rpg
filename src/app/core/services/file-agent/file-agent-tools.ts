import { LLMFunctionDeclaration } from '@hcs/llm-core';

const REASON_DESC = 'One sentence explaining WHY you are calling this tool right now — what you intend to find or change, and how it advances the current task. Required so you (and the user) can re-read the action trace later and follow your reasoning. Avoid restating the file name or echoing the tool name.';

export const FILE_AGENT_TOOLS: LLMFunctionDeclaration[] = [
  {
    name: 'readFile',
    description: 'Read a file (whole or by slice). PREFER grep first when looking for a specific pattern, and prefer getFileOutline + readSection for markdown navigation — readFile pulls raw bytes into context. Use this only when you genuinely need contiguous content. Pass startLine/lineCount to read a slice; omit both to read the whole file (forbidden on non-trivial files unless you have already located dense matches with grep, or the user explicitly asked to see the whole file).',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        filename: { type: 'string', description: 'The exact path of the file' },
        startLine: { type: 'number', description: '1-based starting line. Omit (or 1) to read from the beginning.' },
        lineCount: { type: 'number', description: 'Maximum number of lines to read from startLine. Omit to read to end of file.' }
      },
      required: ['reason', 'filename']
    }
  },
  {
    name: 'replaceFile',
    description: 'Replace the entire content of a file',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        filename: { type: 'string', description: 'The exact path of the file' },
        content: { type: 'string', description: 'The new full content of the file' }
      },
      required: ['reason', 'filename', 'content']
    }
  },
  {
    name: 'getFileOutline',
    description: 'Get the heading outline of a markdown file',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        filename: { type: 'string', description: 'The exact path of the file' }
      },
      required: ['reason', 'filename']
    }
  },
  {
    name: 'grep',
    description: 'Search for a JavaScript regex across files and return matching lines with their file path and 1-based line number. Cheaper than reading whole files when you only need to find where something is mentioned. **DEFAULTS to searching every file** when `filename` is omitted — this is the right mode for surveying scope (e.g. "where does identifier X appear?"); the response carries `filename` on each hit so you can stratify counts per file in your head. Only pass `filename` when you specifically need to scope to one file (e.g. verifying a post-write state of one file). When you plan to follow up with searchReplace, set contextLines to 1 or 2 so you can verify each hit is really what you want to mutate (avoid friendly-fire on edge cases like "---" inside code blocks or YAML front-matter).',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        pattern: { type: 'string', description: 'JavaScript regex source — no surrounding slashes, no inline flags. Example: "TODO|FIXME|脈衝".' },
        filename: { type: 'string', description: 'Optional. Restrict the search to this single file. Omit to search across all files.' },
        caseInsensitive: { type: 'boolean', description: 'Optional. Default false. Set true to search case-insensitively.' },
        maxResults: { type: 'number', description: 'Optional. Cap on the number of matches returned (default 100). Higher values risk filling the context window.' },
        contextLines: { type: 'number', description: 'Optional. Default 0. Number of surrounding lines to include before AND after each match (capped at 10). Each match gains "before" and "after" string arrays. Use 1-2 to sanity-check ambiguous patterns before searchReplace.' }
      },
      required: ['reason', 'pattern']
    }
  },
  {
    name: 'searchReplace',
    description: 'Apply one or more pattern-based replacements to a file in one shot WITHOUT transferring the file body through context. For a single edit, pass a one-element replacements array. For multiple mechanical edits in the same file, pass them all in one call. Returns total replacement count and per-pattern details. Workflow: grep first to confirm match counts, then call with expectedTotalReplacements set to the sum (or set per-entry expectedCount) as a safety net. For non-trivial regex, run with dryRun=true first to preview before/after samples.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        filename: { type: 'string', description: 'The exact path of the file' },
        replacements: {
          type: 'array',
          description: 'One or more replacements to apply in sequence. Each entry: {pattern, replacement, isRegex?, caseInsensitive?, multiline?, expectedCount?}.',
          items: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'The string or regex to find. With isRegex=false (default) this is matched literally. With isRegex=true this is a JavaScript regex source — no surrounding slashes, no inline flags.' },
              replacement: { type: 'string', description: 'The string to replace each match with. Pass "" to delete matches. With isRegex=true, $1/$2/$& backreferences are honored.' },
              isRegex: { type: 'boolean', description: 'Optional. Default false. Set true to treat pattern as a JavaScript regex.' },
              caseInsensitive: { type: 'boolean', description: 'Optional. Default false. Adds the i flag.' },
              multiline: { type: 'boolean', description: 'Optional. Default false. Adds the m flag (^ and $ match line boundaries). Only meaningful with isRegex=true.' },
              expectedCount: { type: 'number', description: 'Optional safety net. If provided and the actual count for THIS pattern differs, the entire call fails and the file is unchanged.' }
            },
            required: ['pattern', 'replacement']
          }
        },
        expectedTotalReplacements: { type: 'number', description: 'Optional safety net summing replacement counts across all entries IN THIS CALL. Each searchReplace call writes to exactly ONE file, so this is a PER-FILE expected total — never a cross-file sum. When renaming across multiple files, stratify your grep results by filename first and pass the per-file count to each call. If the actual per-file total differs from this number, the entire call fails and THE FILE IS NOT CHANGED (the error response will say "File unchanged"); do not narrate success in that case.' },
        dryRun: { type: 'boolean', description: 'Optional. Default false. If true, no write happens — returns counts and up to 3 before/after samples per pattern.' }
      },
      required: ['reason', 'filename', 'replacements']
    }
  },
  {
    name: 'readSection',
    description: 'Read one or more markdown sections by header path. Pass a single path as a one-element array. Returns the body (excluding the heading line) for each section. Output is capped at 500 lines total — check "truncated" on each result.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        filename: { type: 'string', description: 'The exact path of the file' },
        sectionPaths: {
          type: 'array',
          description: 'One or more header paths separated by ">", e.g. ["Character>Stats", "Character>Inventory"].',
          items: { type: 'string' }
        }
      },
      required: ['reason', 'filename', 'sectionPaths']
    }
  },
  {
    name: 'replaceSection',
    description: 'Replace the body of one or more markdown sections. Pass a single section as a one-element updates array. **IMPORTANT: Each entry fails if its section has child subsections — the error lists every child that would be deleted.** Per-entry force: true allows the deletion only when intentional. Otherwise, target each child by its full path (e.g. "Parent>Child") or use insertSection.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        filename: { type: 'string', description: 'The exact path of the file' },
        updates: {
          type: 'array',
          description: 'One or more section updates applied atomically (bottom-to-top so earlier paths remain valid).',
          items: {
            type: 'object',
            properties: {
              sectionPath: { type: 'string', description: 'Path of headers separated by ">", e.g. "Character>Stats>Health"' },
              content: { type: 'string', description: 'The new body content for this section (without the heading line). Pass "" to clear the body.' },
              newTitle: { type: 'string', description: 'Optional. If provided, renames the section header.' },
              force: { type: 'boolean', description: 'Optional. Default false. Set true to allow replacing this entry even if it has child subsections, permanently deleting them.' }
            },
            required: ['sectionPath', 'content']
          }
        }
      },
      required: ['reason', 'filename', 'updates']
    }
  },
  {
    name: 'insertSection',
    description: 'Insert a NEW markdown section (with its own heading) at a specific position. heading must include the hash marks (e.g. "## New Section"). content is the section body ONLY — DO NOT repeat the heading line inside content (the runtime writes the heading from the "heading" arg, then content directly below it; duplicating the heading produces two identical headings in the file). anchor controls where to insert: "prepend" = before everything in the file; "before" = immediately before anchorSectionPath (sibling); "after" = immediately after anchorSectionPath and all its content (sibling); "append-into" = as the last child inside anchorSectionPath. Omit anchor entirely to append at end of file. To insert plain lines (without a heading) into an existing section, use insertIntoSection instead.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        filename: { type: 'string', description: 'The exact path of the file' },
        heading: { type: 'string', description: 'Full heading line including hashes, e.g. "## Equipment"' },
        content: { type: 'string', description: 'Section body content WITHOUT the heading line (optional). Do NOT repeat the value of "heading" here — the runtime emits the heading on its own line and then this content; including the heading again creates a duplicate.' },
        anchor: { type: 'string', enum: ['prepend', 'before', 'after', 'append-into'], description: 'Where to insert. Omit to append at end of file.' },
        anchorSectionPath: { type: 'string', description: 'Required for before/after/append-into. Path like "Character>Stats"' }
      },
      required: ['reason', 'filename', 'heading']
    }
  },
  {
    name: 'insertIntoSection',
    description: 'Insert plain text lines into an existing markdown section, WITHOUT introducing a new heading. Use this to append/prepend body content (paragraphs, list items, table rows) to a section. position="start" inserts right after the heading line (top of the body, before any child sections); position="end" inserts at the very end of the section (after all children, before the next sibling). For inserting a NEW subheading, use insertSection instead.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        filename: { type: 'string', description: 'The exact path of the file' },
        sectionPath: { type: 'string', description: 'Path of headers separated by ">", e.g. "Character>Stats"' },
        content: { type: 'string', description: 'The lines to insert. Multi-line is supported. Will not include any heading line — pass body content only.' },
        position: { type: 'string', enum: ['start', 'end'], description: '"start" = right after the heading; "end" = after all body and child sections.' }
      },
      required: ['reason', 'filename', 'sectionPath', 'content', 'position']
    }
  },
  {
    name: 'listChatMessages',
    description: 'Outline of recent chat messages — cheap preview without bodies. Returns id, role, charCount, summary, intent, hasLogs. USE FIRST for any timing / sequence / pacing / "is X reasonable" question — summaries usually suffice. Also use first when the user references the story but no specific phrase. Paginate older with before=oldest-id-seen. Skips save-intent (engine file-update) turns by default. Errors if no chat history is available.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        limit: { type: 'number', description: 'Maximum number of messages to return, newest first (default 30, capped at 100).' },
        before: { type: 'string', description: 'Optional. Return only messages older than this message id. Use the oldest id from a prior call to paginate backwards.' },
        includeHidden: { type: 'boolean', description: 'Optional. Default false. Set true to include messages flagged isHidden (engine-suppressed system turns).' },
        includeSaves: { type: 'boolean', description: 'Optional. Default false. Set true ONLY if the user is asking about KB-write history itself — save-intent turns contain XML update tags, not narrative.' }
      },
      required: ['reason']
    }
  },
  {
    name: 'searchChatMessages',
    description: 'Regex search across in-game chat messages — the chat-side analogue of grep. Returns hits with messageId, role, the scope that matched, and a snippet. Each message is capped at 3 hits (the 3rd carries moreInSameMessage:N) — multiple matches inside the same turn no longer dominate results. PREFER this over readChatMessage when you have a specific phrase, name, or token to find. For TIMING / SEQUENCE / pacing questions, listChatMessages with summaries is usually a cheaper first step. scope is REQUIRED and controls which field is searched — see the scope parameter docs for when to pick "content" / "thought" / "summary" / "all". For event-lookup questions ("when did X / who did Y") prefer "summary"; "content" is for verbatim phrase / quote / name lookups only. Save-intent turns are skipped by default. Tool errors if no chat history is available.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        pattern: { type: 'string', description: 'JavaScript regex source — no surrounding slashes, no inline flags. Note: in-game narrative may be in a different language than the user\'s question (see the Languages block in the system prompt) — match the narrative language, or use a language-agnostic token (proper name, number, identifier).' },
        scope: { type: 'string', enum: ['content', 'thought', 'summary', 'all'], description: 'REQUIRED. Each chat turn carries parallel fields — pick which to scan:\n  - "content": player-visible narrative prose (long-form story, dialogue, action). Use for phrase / quote / proper-name lookups.\n  - "thought": engine chain-of-thought (why this turn went the way it did). Use for "why did the engine decide X" questions.\n  - "summary": engine-emitted dense one-liner with structured event markers (typically pipe-separated actor-verb-object segments). Highest event density per byte; the most reliable hit when you do not know the exact phrasing the narrative used. Use for "when did X happen / who did Y / which turn ASSIGNED/GRANTED/COMPLETED Z" event-lookup questions — pattern-matching on narrative content often misses these because the canonical event verb only appears in summary.\n  - "all": scan content + thought + summary together. Use when uncertain.\nDecide by question shape, not by habit — content-only searches frequently miss event lookups.' },
        caseInsensitive: { type: 'boolean', description: 'Optional. Default false.' },
        limit: { type: 'number', description: 'Maximum hits to return across all messages (default 100, capped at 300).' },
        contextChars: { type: 'number', description: 'Optional. Default 80. Characters of context around each match in the returned snippet (capped at 400).' },
        includeSaves: { type: 'boolean', description: 'Optional. Default false. Set true ONLY if the user is asking about KB-write history itself.' }
      },
      required: ['reason', 'pattern', 'scope']
    }
  },
  {
    name: 'readChatMessage',
    description: 'Pinpoint-read one or more chat messages by id — the chat-side analogue of readSection. Pass a single id as a one-element array. Use AFTER listChatMessages / searchChatMessages narrow down which turn(s) matter; do not call this with guessed ids. "include" controls which fields come back per message — defaults to ["content"] to keep the response small. Add "thought" to see the model\'s reasoning, "logs" to inspect the *_log arrays (use readTurnLogs if logs are all you want), "analysis"/"summary"/"intent" for engine-computed fields. Tool errors if no chat history is available; per-id "not found" is reported inside the result, not as a top-level error.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        messageIds: {
          type: 'array',
          description: 'One or more chat message ids (from listChatMessages or searchChatMessages).',
          items: { type: 'string' }
        },
        include: {
          type: 'array',
          description: 'Fields to include per message. Default ["content"].',
          items: { type: 'string', enum: ['content', 'thought', 'logs', 'analysis', 'summary', 'intent'] }
        }
      },
      required: ['reason', 'messageIds']
    }
  },
  {
    name: 'readTurnLogs',
    description: 'Read the structured per-turn logs (character_log / world_log / inventory_log / quest_log) — these are entries the engine wrote to KB during that turn, the most common ground truth for "the chat says X happened but the KB file says Y" fixes. Returns flattened entries grouped by message + kind. Pass messageIds to inspect specific turns; omit messageIds and use "recent" to scan the latest N turns. "kinds" filters which log types come back. Tool errors if no chat history is available.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        messageIds: { type: 'array', description: 'Optional. Specific message ids to inspect. If omitted, falls back to the latest "recent" turns.', items: { type: 'string' } },
        kinds: { type: 'array', description: 'Optional. Which log types to include. Default: all four (character, world, inventory, quest).', items: { type: 'string', enum: ['character', 'world', 'inventory', 'quest'] } },
        recent: { type: 'number', description: 'Optional. Only used when messageIds is omitted. Number of latest messages to scan (default 20, capped at 100).' }
      },
      required: ['reason']
    }
  },
  {
    name: 'uiMap',
    description: 'Return the FULL UI feature tree (every button / panel / dialog the helper knows about). Call ONCE per turn when the user asks about UI locations or controls — the response is an indented markdown tree of `path — name — description` lines. Emit deep links as `app://hint/<full-path>` (e.g. `app://hint/chat-input/chat-config/profile-manage-menu/disk-sync-pull`); the markdown renderer auto-expands them into per-segment clickable breadcrumbs, so DO NOT manually compose `[A](app://hint/A) > [B](...)` chains. Append `?do=activate` only on entries marked `(activatable)` AND when the user explicitly asked you to trigger the action for them; default to plain URLs (highlight on click).',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC }
      },
      required: ['reason']
    }
  },
  {
    name: 'listBooks',
    description: 'List all books (game saves) in the user\'s library — id, name, collection, last-active timestamp, turn count, isActive flag. Use when the user references a book by name ("the elf playthrough", "yesterday\'s save") or asks to compare / inspect a non-active book. Pair the returned ids with `app://book/<id>[/<action>]` URLs to give the user clickable deep-links into the sidebar.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        collectionId: { type: 'string', description: 'Optional. Filter to one collection only (use the id from listCollections; "root" is the built-in unsorted folder).' },
        limit: { type: 'number', description: 'Optional. Max books to return, newest activity first. Default 50, capped at 200.' }
      },
      required: ['reason']
    }
  },
  {
    name: 'listCollections',
    description: 'List all book collections (folders) in the user\'s library — id, name, book count, isRoot flag. Use when the user references a collection by name ("the side-stories folder") or asks to add a book under one. Pair the returned ids with `app://collection/<id>[/<action>]` URLs for clickable deep-links. Root collection is the built-in unsorted folder; the agent cannot rename or delete it.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC }
      },
      required: ['reason']
    }
  },
  {
    name: 'proposeChatReplace',
    description: 'Propose a batch find/replace across the in-game chat messages, gated behind user approval. Opens a prefilled chat-replace dialog that the user can review, adjust, or cancel — the replacement only happens when the user clicks Replace All. Returns the outcome so you can see what actually happened (`applied` carries the final search/replace + filters + replaceCount, or is null when the user cancelled; `divergedFromProposal` flags whether the user changed any field before applying). Only available on the `main` agent surface (chat panel / PiP) — calling from the `file-edit` surface returns an error. Do NOT use this tool to "preview" a search; the dialog itself is the preview, and opening it interrupts the user.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_DESC },
        search: { type: 'string', description: 'The string or regex to find. With regex=false (default) this is matched literally. With regex=true this is a JavaScript regex source — no surrounding slashes, no inline flags.' },
        replace: { type: 'string', description: 'The string to replace each match with. Pass "" to delete matches. With regex=true, $1/$2/$& backreferences are honored.' },
        caseSensitive: { type: 'boolean', description: 'Optional. Default false (case-insensitive).' },
        wholeWord: { type: 'boolean', description: 'Optional. Default false. Only meaningful with regex=false — wraps the search in word boundaries.' },
        regex: { type: 'boolean', description: 'Optional. Default false. Set true to treat `search` as a JavaScript regex.' },
        intentFilter: { type: 'string', enum: ['all', 'action', 'continue', 'fast_forward', 'system', 'save'], description: 'Optional. Default "all". Restrict to messages with this intent.' },
        roleFilter: { type: 'string', enum: ['all', 'user', 'model'], description: 'Optional. Default "all". Restrict to user or model messages.' },
        fieldFilter: { type: 'string', enum: ['all', 'story', 'summary', 'logs'], description: 'Optional. Default "all". Which field of each message to scan: story=narrative content, summary=engine summary, logs=structured inventory/quest/world logs.' }
      },
      required: ['reason', 'search', 'replace']
    }
  },
  {
    name: 'reportProgress',
    description: 'Send a progress update to the user mid-task. The agent CONTINUES after this call — use it to narrate ongoing work without yielding control. Do NOT use this when the entire task is complete.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Short progress note to show to the user' } },
      required: ['message']
    }
  },
  {
    name: 'submitResponse',
    description: 'End the agent turn and hand control back to the user. Call this ONLY when (a) the entire task is fully complete and you want to summarize, (b) you need to ask the user a question or need clarification, or (c) you are blocked and cannot proceed. After this call the agent stops and the user must type a new message to resume.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The final summary, question, or clarification to show to the user' } },
      required: ['message']
    }
  }
];

const ACTION_ENUM = [
  'readFile', 'replaceFile', 'getFileOutline', 'grep', 'searchReplace',
  'readSection', 'replaceSection', 'insertSection', 'insertIntoSection',
  'listChatMessages', 'searchChatMessages', 'readChatMessage', 'readTurnLogs',
  'listBooks', 'listCollections',
  'proposeChatReplace',
  'reportProgress', 'submitResponse'
];

export function buildJsonSchema(isLocal: boolean): object {
  if (isLocal) {
    return {
      type: 'object',
      anyOf: [
        { properties: { action: { type: 'string', enum: ['readFile'] }, args: { type: 'object', properties: { reason: { type: 'string' }, filename: { type: 'string' }, startLine: { type: 'number' }, lineCount: { type: 'number' } }, required: ['reason', 'filename'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['replaceFile'] }, args: { type: 'object', properties: { reason: { type: 'string' }, filename: { type: 'string' }, content: { type: 'string' } }, required: ['reason', 'filename', 'content'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['getFileOutline'] }, args: { type: 'object', properties: { reason: { type: 'string' }, filename: { type: 'string' } }, required: ['reason', 'filename'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['grep'] }, args: { type: 'object', properties: { reason: { type: 'string' }, pattern: { type: 'string' }, filename: { type: 'string' }, caseInsensitive: { type: 'boolean' }, maxResults: { type: 'number' }, contextLines: { type: 'number' } }, required: ['reason', 'pattern'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['searchReplace'] }, args: { type: 'object', properties: { reason: { type: 'string' }, filename: { type: 'string' }, replacements: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, replacement: { type: 'string' }, isRegex: { type: 'boolean' }, caseInsensitive: { type: 'boolean' }, multiline: { type: 'boolean' }, expectedCount: { type: 'number' } }, required: ['pattern', 'replacement'] } }, expectedTotalReplacements: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['reason', 'filename', 'replacements'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['readSection'] }, args: { type: 'object', properties: { reason: { type: 'string' }, filename: { type: 'string' }, sectionPaths: { type: 'array', items: { type: 'string' } } }, required: ['reason', 'filename', 'sectionPaths'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['replaceSection'] }, args: { type: 'object', properties: { reason: { type: 'string' }, filename: { type: 'string' }, updates: { type: 'array', items: { type: 'object', properties: { sectionPath: { type: 'string' }, content: { type: 'string' }, newTitle: { type: 'string' }, force: { type: 'boolean' } }, required: ['sectionPath', 'content'] } } }, required: ['reason', 'filename', 'updates'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['insertSection'] }, args: { type: 'object', properties: { reason: { type: 'string' }, filename: { type: 'string' }, heading: { type: 'string' }, content: { type: 'string' }, anchor: { type: 'string', enum: ['prepend', 'before', 'after', 'append-into'] }, anchorSectionPath: { type: 'string' } }, required: ['reason', 'filename', 'heading'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['insertIntoSection'] }, args: { type: 'object', properties: { reason: { type: 'string' }, filename: { type: 'string' }, sectionPath: { type: 'string' }, content: { type: 'string' }, position: { type: 'string', enum: ['start', 'end'] } }, required: ['reason', 'filename', 'sectionPath', 'content', 'position'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['listChatMessages'] }, args: { type: 'object', properties: { reason: { type: 'string' }, limit: { type: 'number' }, before: { type: 'string' }, includeHidden: { type: 'boolean' }, includeSaves: { type: 'boolean' } }, required: ['reason'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['searchChatMessages'] }, args: { type: 'object', properties: { reason: { type: 'string' }, pattern: { type: 'string' }, scope: { type: 'string', enum: ['content', 'thought', 'summary', 'all'] }, caseInsensitive: { type: 'boolean' }, limit: { type: 'number' }, contextChars: { type: 'number' }, includeSaves: { type: 'boolean' } }, required: ['reason', 'pattern', 'scope'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['readChatMessage'] }, args: { type: 'object', properties: { reason: { type: 'string' }, messageIds: { type: 'array', items: { type: 'string' } }, include: { type: 'array', items: { type: 'string', enum: ['content', 'thought', 'logs', 'analysis', 'summary', 'intent'] } } }, required: ['reason', 'messageIds'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['readTurnLogs'] }, args: { type: 'object', properties: { reason: { type: 'string' }, messageIds: { type: 'array', items: { type: 'string' } }, kinds: { type: 'array', items: { type: 'string', enum: ['character', 'world', 'inventory', 'quest'] } }, recent: { type: 'number' } }, required: ['reason'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['listBooks'] }, args: { type: 'object', properties: { reason: { type: 'string' }, collectionId: { type: 'string' }, limit: { type: 'number' } }, required: ['reason'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['listCollections'] }, args: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['proposeChatReplace'] }, args: { type: 'object', properties: { reason: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' }, caseSensitive: { type: 'boolean' }, wholeWord: { type: 'boolean' }, regex: { type: 'boolean' }, intentFilter: { type: 'string', enum: ['all', 'action', 'continue', 'fast_forward', 'system', 'save'] }, roleFilter: { type: 'string', enum: ['all', 'user', 'model'] }, fieldFilter: { type: 'string', enum: ['all', 'story', 'summary', 'logs'] } }, required: ['reason', 'search', 'replace'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['reportProgress'] }, args: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['submitResponse'] }, args: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } }, required: ['action', 'args'] }
      ]
    };
  }
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTION_ENUM, description: 'The tool to use.' },
      args: {
        type: 'object',
        description: 'Arguments for the tool. Required fields depend on the action. All file-operation actions also require a "reason" string.',
        properties: {
          reason: { type: 'string', description: REASON_DESC },
          filename: { type: 'string' },
          content: { type: 'string' },
          sectionPath: { type: 'string' },
          sectionPaths: { type: 'array', items: { type: 'string' } },
          updates: { type: 'array', items: { type: 'object' } },
          replacements: { type: 'array', items: { type: 'object' } },
          expectedTotalReplacements: { type: 'number' },
          newTitle: { type: 'string' },
          message: { type: 'string' },
          startLine: { type: 'number' },
          lineCount: { type: 'number' },
          pattern: { type: 'string' },
          caseInsensitive: { type: 'boolean' },
          maxResults: { type: 'number' },
          contextLines: { type: 'number' },
          dryRun: { type: 'boolean' },
          heading: { type: 'string' },
          anchor: { type: 'string' },
          anchorSectionPath: { type: 'string' },
          position: { type: 'string' },
          limit: { type: 'number' },
          before: { type: 'string' },
          includeHidden: { type: 'boolean' },
          includeSaves: { type: 'boolean' },
          scope: { type: 'string' },
          messageIds: { type: 'array', items: { type: 'string' } },
          include: { type: 'array', items: { type: 'string' } },
          kinds: { type: 'array', items: { type: 'string' } },
          recent: { type: 'number' },
          contextChars: { type: 'number' },
          collectionId: { type: 'string' },
          search: { type: 'string' },
          replace: { type: 'string' },
          caseSensitive: { type: 'boolean' },
          wholeWord: { type: 'boolean' },
          regex: { type: 'boolean' },
          intentFilter: { type: 'string' },
          roleFilter: { type: 'string' },
          fieldFilter: { type: 'string' }
        }
      }
    },
    required: ['action', 'args']
  };
}
