import { LLMFunctionDeclaration } from '@hcs/llm-core';

export const FILE_AGENT_TOOLS: LLMFunctionDeclaration[] = [
  {
    name: 'readFile',
    description: 'Read a file (whole or by slice). PREFER grep first when looking for a specific pattern, and prefer getFileOutline + readSection for markdown navigation — readFile pulls raw bytes into context. Use this only when you genuinely need contiguous content. Pass startLine/lineCount to read a slice; omit both to read the whole file (forbidden on non-trivial files unless you have already located dense matches with grep, or the user explicitly asked to see the whole file).',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        startLine: { type: 'number', description: '1-based starting line. Omit (or 1) to read from the beginning.' },
        lineCount: { type: 'number', description: 'Maximum number of lines to read from startLine. Omit to read to end of file.' }
      },
      required: ['filename']
    }
  },
  {
    name: 'replaceFile',
    description: 'Replace the entire content of a file',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        content: { type: 'string', description: 'The new full content of the file' }
      },
      required: ['filename', 'content']
    }
  },
  {
    name: 'getFileOutline',
    description: 'Get the heading outline of a markdown file',
    parameters: {
      type: 'object',
      properties: { filename: { type: 'string', description: 'The exact path of the file' } },
      required: ['filename']
    }
  },
  {
    name: 'grep',
    description: 'Search for a JavaScript regex across files and return matching lines with their file path and 1-based line number. Cheaper than reading whole files when you only need to find where something is mentioned. Defaults to searching every file; pass filename to restrict to one. When you plan to follow up with searchReplace, set contextLines to 1 or 2 so you can verify each hit is really what you want to mutate (avoid friendly-fire on edge cases like "---" inside code blocks or YAML front-matter).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regex source — no surrounding slashes, no inline flags. Example: "TODO|FIXME|脈衝".' },
        filename: { type: 'string', description: 'Optional. Restrict the search to this single file. Omit to search across all files.' },
        caseInsensitive: { type: 'boolean', description: 'Optional. Default false. Set true to search case-insensitively.' },
        maxResults: { type: 'number', description: 'Optional. Cap on the number of matches returned (default 100). Higher values risk filling the context window.' },
        contextLines: { type: 'number', description: 'Optional. Default 0. Number of surrounding lines to include before AND after each match (capped at 10). Each match gains "before" and "after" string arrays. Use 1-2 to sanity-check ambiguous patterns before searchReplace.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'searchReplace',
    description: 'Apply one or more pattern-based replacements to a file in one shot WITHOUT transferring the file body through context. For a single edit, pass a one-element replacements array. For multiple mechanical edits in the same file, pass them all in one call. Returns total replacement count and per-pattern details. Workflow: grep first to confirm match counts, then call with expectedTotalReplacements set to the sum (or set per-entry expectedCount) as a safety net. For non-trivial regex, run with dryRun=true first to preview before/after samples.',
    parameters: {
      type: 'object',
      properties: {
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
        expectedTotalReplacements: { type: 'number', description: 'Optional safety net for the total across all entries. If provided and the total differs, the call fails and the file is unchanged.' },
        dryRun: { type: 'boolean', description: 'Optional. Default false. If true, no write happens — returns counts and up to 3 before/after samples per pattern.' }
      },
      required: ['filename', 'replacements']
    }
  },
  {
    name: 'readSection',
    description: 'Read one or more markdown sections by header path. Pass a single path as a one-element array. Returns the body (excluding the heading line) for each section. Output is capped at 500 lines total — check "truncated" on each result.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        sectionPaths: {
          type: 'array',
          description: 'One or more header paths separated by ">", e.g. ["Character>Stats", "Character>Inventory"].',
          items: { type: 'string' }
        }
      },
      required: ['filename', 'sectionPaths']
    }
  },
  {
    name: 'replaceSection',
    description: 'Replace the body of one or more markdown sections. Pass a single section as a one-element updates array. **IMPORTANT: Each entry fails if its section has child subsections — the error lists every child that would be deleted.** Per-entry force: true allows the deletion only when intentional. Otherwise, target each child by its full path (e.g. "Parent>Child") or use insertSection.',
    parameters: {
      type: 'object',
      properties: {
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
      required: ['filename', 'updates']
    }
  },
  {
    name: 'insertSection',
    description: 'Insert a NEW markdown section (with its own heading) at a specific position. heading must include the hash marks (e.g. "## New Section"). content is the section body without the heading line (optional). anchor controls where to insert: "prepend" = before everything in the file; "before" = immediately before anchorSectionPath (sibling); "after" = immediately after anchorSectionPath and all its content (sibling); "append-into" = as the last child inside anchorSectionPath. Omit anchor entirely to append at end of file. To insert plain lines (without a heading) into an existing section, use insertIntoSection instead.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        heading: { type: 'string', description: 'Full heading line including hashes, e.g. "## Equipment"' },
        content: { type: 'string', description: 'Section body content without the heading line (optional)' },
        anchor: { type: 'string', enum: ['prepend', 'before', 'after', 'append-into'], description: 'Where to insert. Omit to append at end of file.' },
        anchorSectionPath: { type: 'string', description: 'Required for before/after/append-into. Path like "Character>Stats"' }
      },
      required: ['filename', 'heading']
    }
  },
  {
    name: 'insertIntoSection',
    description: 'Insert plain text lines into an existing markdown section, WITHOUT introducing a new heading. Use this to append/prepend body content (paragraphs, list items, table rows) to a section. position="start" inserts right after the heading line (top of the body, before any child sections); position="end" inserts at the very end of the section (after all children, before the next sibling). For inserting a NEW subheading, use insertSection instead.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        sectionPath: { type: 'string', description: 'Path of headers separated by ">", e.g. "Character>Stats"' },
        content: { type: 'string', description: 'The lines to insert. Multi-line is supported. Will not include any heading line — pass body content only.' },
        position: { type: 'string', enum: ['start', 'end'], description: '"start" = right after the heading; "end" = after all body and child sections.' }
      },
      required: ['filename', 'sectionPath', 'content', 'position']
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
  'reportProgress', 'submitResponse'
];

export function buildJsonSchema(isLocal: boolean): object {
  if (isLocal) {
    return {
      type: 'object',
      anyOf: [
        { properties: { action: { type: 'string', enum: ['readFile'] }, args: { type: 'object', properties: { filename: { type: 'string' }, startLine: { type: 'number' }, lineCount: { type: 'number' } }, required: ['filename'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['replaceFile'] }, args: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } }, required: ['filename', 'content'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['getFileOutline'] }, args: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['grep'] }, args: { type: 'object', properties: { pattern: { type: 'string' }, filename: { type: 'string' }, caseInsensitive: { type: 'boolean' }, maxResults: { type: 'number' }, contextLines: { type: 'number' } }, required: ['pattern'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['searchReplace'] }, args: { type: 'object', properties: { filename: { type: 'string' }, replacements: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, replacement: { type: 'string' }, isRegex: { type: 'boolean' }, caseInsensitive: { type: 'boolean' }, multiline: { type: 'boolean' }, expectedCount: { type: 'number' } }, required: ['pattern', 'replacement'] } }, expectedTotalReplacements: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['filename', 'replacements'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['readSection'] }, args: { type: 'object', properties: { filename: { type: 'string' }, sectionPaths: { type: 'array', items: { type: 'string' } } }, required: ['filename', 'sectionPaths'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['replaceSection'] }, args: { type: 'object', properties: { filename: { type: 'string' }, updates: { type: 'array', items: { type: 'object', properties: { sectionPath: { type: 'string' }, content: { type: 'string' }, newTitle: { type: 'string' }, force: { type: 'boolean' } }, required: ['sectionPath', 'content'] } } }, required: ['filename', 'updates'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['insertSection'] }, args: { type: 'object', properties: { filename: { type: 'string' }, heading: { type: 'string' }, content: { type: 'string' }, anchor: { type: 'string', enum: ['prepend', 'before', 'after', 'append-into'] }, anchorSectionPath: { type: 'string' } }, required: ['filename', 'heading'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['insertIntoSection'] }, args: { type: 'object', properties: { filename: { type: 'string' }, sectionPath: { type: 'string' }, content: { type: 'string' }, position: { type: 'string', enum: ['start', 'end'] } }, required: ['filename', 'sectionPath', 'content', 'position'], additionalProperties: false } }, required: ['action', 'args'] },
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
        description: 'Arguments for the tool. Required fields depend on the action.',
        properties: {
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
          position: { type: 'string' }
        }
      }
    },
    required: ['action', 'args']
  };
}
