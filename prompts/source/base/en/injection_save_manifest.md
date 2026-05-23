> [SaveAgent] Save — produce a list of hunks

You do not write KB updates into the conversation. Instead you output a **list of hunks
(a JSON array)**: review every log + summary since `--- ACT START ---`, decide which KB
files need what changes, and express each change as one hunk.

## User Input

```
{{USER_INPUT}}
```

> **User-specified scope takes priority**: when the input explicitly limits scope (e.g. "only save inventory changes", "only update locations"), produce hunks for the named scope only and leave the rest untouched.

<!--@include:partials/save-completeness-checklist.md-->

<!--@include:partials/save-file-classification.md-->

<!--@include:partials/save-log-mapping.md-->

## How to write a hunk

Each hunk is one verbatim edit to a KB file, with these fields:

- `file`: target KB filename, exactly as it appears in the file list provided to you.
- `context`: heading breadcrumb crumbs as a JSON `string[]`, outermost → innermost (e.g. `["Section", "Subsection"]`). **Each element is the heading's raw text only — no `#` prefix, no `>` separator.** Each crumb must point at an actual **ATX heading** (`#`–`######`) in the file — **do not** use list-item / bullet / table-row / paragraph text as a crumb. Use an empty array `[]` to target the file root. Match the file's heading text **verbatim** including any parenthetical suffix — e.g. if the file has `## Subsection (updated each act)`, write `["Section", "Subsection (updated each act)"]`, not `["Section", "Subsection"]`.
- `target` (optional): the **verbatim existing text** to replace or delete, copied character-for-character from the file (including indentation and punctuation). Omit it to append at the end of the `context` section.
- `replacement`: the new content, written as **finished markdown**.
- `sourceMessageIds` (optional): see the section below.

The three operations are determined by which fields are present:

- **Add**: omit `target`; `replacement` is appended at the end of the `context` section.
- **Replace**: `target` is the verbatim original, `replacement` is the new content.
- **Delete**: `target` is the verbatim original, `replacement` is an empty string `""`.

> **Match the file's format verbatim**: `target` / `replacement` are finished text. When writing `replacement`:
> - If the KB file has a **format-definition section** at the top (user-authored format rules), you **must** render strictly to that definition — do not impose a format of your own.
> - Without an explicit format definition, follow the format demonstrated by the file's existing entries.
>
> `target` must match the source file exactly, or the apply step will fail to anchor it.

For the Story Outline (chronicle) file, write the ACT's progress as a new time-node hunk covering the key turning points, conflict outcomes, and notable lines, following the file's existing chronicle style. Chronicle hunks summarise the whole ACT rather than any single message, so **omit `sourceMessageIds`** for them — listing every message in the ACT carries no signal for the downstream consistency layer.

Field rules for updating character entries:

<!--@include:partials/save-character-status-rules.md-->

### Evidence annotation — each hunk's `sourceMessageIds` (optional)

Every hunk may carry a `sourceMessageIds: string[]` listing the `messageId` values from this ACT that **directly** support it. The downstream consistency-checking layer uses these anchors to look up the original text.

Each message in the rendered chat history (including every condensed entry inside a smart-context summary block) carries an `[id: <messageId>]` tag. The id you cite for a hunk must be **copied verbatim from one of these tags** — do not paraphrase, hash, or invent ids; an id the framework cannot match against the conversation is dropped on validation.

- **List messageIds**: the hunk's facts are explicitly described in those model messages.
- **`[]` empty array**: you deliberately judge the hunk to be a contextual inference with no single message backing it.
- **Omitted**: equivalent to an empty array — treated as an inference by default.

Only cite messageIds from this ACT (after `--- ACT START ---`); 1-3 anchors per hunk is enough, no need to be exhaustive.

## Reminders for this turn

- Your entire output must be a **single JSON array**, each element a hunk.
- Do not add markdown / any prose outside the JSON.
- When there is nothing to save, output an empty array `[]`.
- Do **not** write uncertain content (prefer to skip and produce no hunk for it).
