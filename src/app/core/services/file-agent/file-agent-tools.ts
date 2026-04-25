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
    description: 'Replace every occurrence of a pattern in a file in one shot WITHOUT transferring the file body through context. Ideal for mechanical edits scattered across a file: deleting every "---" line, renaming a token everywhere, fixing a recurring typo. Returns only the replacement count, not the new content. Workflow: grep first to confirm match count, then call searchReplace with expectedReplacements set to that count as a safety net. For non-trivial regex, run with dryRun=true first to preview before/after samples.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        pattern: { type: 'string', description: 'The string or regex to find. With isRegex=false (default) this is matched literally. With isRegex=true this is a JavaScript regex source — no surrounding slashes, no inline flags.' },
        replacement: { type: 'string', description: 'The string to replace each match with. Pass "" to delete matches. With isRegex=true, $1/$2/$& backreferences are honored.' },
        isRegex: { type: 'boolean', description: 'Optional. Default false. Set true to treat pattern as a JavaScript regex.' },
        caseInsensitive: { type: 'boolean', description: 'Optional. Default false. Adds the i flag.' },
        multiline: { type: 'boolean', description: 'Optional. Default false. Adds the m flag (^ and $ match line boundaries). Only meaningful with isRegex=true.' },
        expectedReplacements: { type: 'number', description: 'Optional safety net. If provided and the actual replacement count differs, the call fails and the file is unchanged. Set this to your grep count.' },
        dryRun: { type: 'boolean', description: 'Optional. Default false. If true, no write happens — returns { replacements, samples: [up to 5 before/after pairs] } so you can verify the pattern.' }
      },
      required: ['filename', 'pattern', 'replacement']
    }
  },
  {
    name: 'readSection',
    description: 'Read a specific section by header path',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        sectionPath: { type: 'string', description: 'Path of headers separated by ">", e.g. "Character>Stats>Health"' }
      },
      required: ['filename', 'sectionPath']
    }
  },
  {
    name: 'replaceSection',
    description: 'Replace a specific section content',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        sectionPath: { type: 'string', description: 'Path of headers separated by ">", e.g. "Character>Stats>Health"' },
        content: { type: 'string', description: 'The new content for this section (without the heading line)' },
        newTitle: { type: 'string', description: 'If provided, renames the section header' }
      },
      required: ['filename', 'sectionPath', 'content']
    }
  },
  {
    name: 'batchSearchReplace',
    description: 'Apply multiple replacements to a single file in sequence without transferring the file body. Efficient for complex reformatting across a whole file. Returns total replacement count and samples.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'The string or regex to find.' },
              replacement: { type: 'string', description: 'The replacement string.' },
              isRegex: { type: 'boolean', description: 'Default false.' },
              caseInsensitive: { type: 'boolean', description: 'Default false.' },
              multiline: { type: 'boolean', description: 'Default false.' }
            },
            required: ['pattern', 'replacement']
          }
        },
        expectedTotalReplacements: { type: 'number', description: 'Optional safety net for total across all patterns.' },
        dryRun: { type: 'boolean', description: 'Optional. Default false.' }
      },
      required: ['filename', 'replacements']
    }
  },
  {
    name: 'readMultipleSections',
    description: 'Read contents of multiple markdown sections in one call. Combined output is truncated if too large.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        sectionPaths: {
          type: 'array',
          items: { type: 'string', description: 'Path like "Character>Stats"' }
        }
      },
      required: ['filename', 'sectionPaths']
    }
  },
  {
    name: 'replaceMultipleSections',
    description: 'Update multiple markdown sections in one call. Efficient for bulk updates.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The exact path of the file' },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sectionPath: { type: 'string', description: 'Path like "Character>Stats"' },
              content: { type: 'string', description: 'New body content' },
              newTitle: { type: 'string', description: 'Optional new title' }
            },
            required: ['sectionPath', 'content']
          }
        }
      },
      required: ['filename', 'updates']
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
  'readSection', 'replaceSection', 'reportProgress', 'submitResponse',
  'batchSearchReplace', 'readMultipleSections', 'replaceMultipleSections'
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
        { properties: { action: { type: 'string', enum: ['searchReplace'] }, args: { type: 'object', properties: { filename: { type: 'string' }, pattern: { type: 'string' }, replacement: { type: 'string' }, isRegex: { type: 'boolean' }, caseInsensitive: { type: 'boolean' }, multiline: { type: 'boolean' }, expectedReplacements: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['filename', 'pattern', 'replacement'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['readSection'] }, args: { type: 'object', properties: { filename: { type: 'string' }, sectionPath: { type: 'string' } }, required: ['filename', 'sectionPath'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['replaceSection'] }, args: { type: 'object', properties: { filename: { type: 'string' }, sectionPath: { type: 'string' }, content: { type: 'string' }, newTitle: { type: 'string' } }, required: ['filename', 'sectionPath', 'content'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['readMultipleSections'] }, args: { type: 'object', properties: { filename: { type: 'string' }, sectionPaths: { type: 'array', items: { type: 'string' } } }, required: ['filename', 'sectionPaths'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['replaceMultipleSections'] }, args: { type: 'object', properties: { filename: { type: 'string' }, updates: { type: 'array', items: { type: 'object', properties: { sectionPath: { type: 'string' }, content: { type: 'string' }, newTitle: { type: 'string' } }, required: ['sectionPath', 'content'] } } }, required: ['filename', 'updates'], additionalProperties: false } }, required: ['action', 'args'] },
        { properties: { action: { type: 'string', enum: ['batchSearchReplace'] }, args: { type: 'object', properties: { filename: { type: 'string' }, replacements: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, replacement: { type: 'string' }, isRegex: { type: 'boolean' }, caseInsensitive: { type: 'boolean' }, multiline: { type: 'boolean' } }, required: ['pattern', 'replacement'] } }, expectedTotalReplacements: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['filename', 'replacements'], additionalProperties: false } }, required: ['action', 'args'] },
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
          replacement: { type: 'string' },
          isRegex: { type: 'boolean' },
          multiline: { type: 'boolean' },
          expectedReplacements: { type: 'number' },
          dryRun: { type: 'boolean' }
        }
      }
    },
    required: ['action', 'args']
  };
}
