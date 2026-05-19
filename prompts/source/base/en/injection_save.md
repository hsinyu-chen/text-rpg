> User input for this turn:
```
{{USER_INPUT}}
```
## User Input Format
`<Save>Scope or Revision Request`

## Processing Rules
User requests an analysis of plot progress **since the `--- ACT START ---` marker** to generate XML file updates.

> [!CAUTION]
> **COMPLETENESS IS MANDATORY**: Partial or lazy updates will **corrupt game state** and cause continuity errors. You MUST process ALL accumulated LOGs exhaustively. There is NO "save for later" - anything missed is PERMANENTLY LOST.

> **User scope override**: If the `<Save>` input explicitly narrows scope (e.g., "save only inventory", "update just the location", "fix only X"), the user's specified scope **supersedes** the completeness mandate — produce ONLY the requested updates and omit the rest. Completeness applies to the default unscoped save.

<!--@include:partials/save-completeness-checklist.md-->

> [!IMPORTANT]
> **[Persist Observation-Generated Settings]**: If this ACT generated new people/things/location details via `Look`/`Observe` and logged them, you **MUST** persist them into the proper files (characters → `{{FILE_CHARACTER_STATUS}}`; world/location/specialty/faction → `{{FILE_WORLD_FACTIONS}}`; equipment specs → `{{FILE_TECH_EQUIPMENT}}`). **FORBIDDEN** to leave generated details only in the logs.

### Field Restrictions
- **`analysis`** and **`summary`** fields MUST be empty strings `""`.
- All content must be output directly in the `story` field.
- All analysis work should be done in the `thinking` phase.

<!--@include:partials/save-xml-format.md-->

<!--@include:partials/save-file-classification.md-->


## Specific File Update Rules

### Story Outline (`{{FILE_STORY_OUTLINE}}`)
ACT Format:
```
## Act.[Number] - [Title]
- **[Time Node/Key Event Name]**
    [Event Details: Including motivation, process, key dialogue, and results]
- **[Time Node/Key Event Name]**
    [Event Details: Including motivation, process, key dialogue, and results]
```
- End of ACT must have `**act_end_time**:` field.
- For items in the "啟動劇情引導 / Story Hooks" section (e.g., "Event Trigger X"), add `(Completed)` to the **item heading** once triggered.
- The plot summary details should be arranged in chronological order.

> [!CRITICAL] Chronicle Principle
> - Decompose plot into at least 5-8 **[Subtitle]** time nodes. No 3-5 line summaries.
> - Record strategies, casualties, key turning points. No mere summaries.
> - Excerpt important characters' key quotes.


<!--@include:partials/save-character-status-rules.md-->

<!--@include:partials/save-log-mapping.md-->

## This Turn Reminders
- `analysis` and `summary` fields MUST be empty string `""`.
- Unless user asks to "Save Current Turn", ONLY output what is requested.

> [!IMPORTANT]
> **FINAL COMPLETENESS CHECK**:
> Before submitting, re-read ALL logs since `--- ACT START ---` and verify EVERY single entry has a corresponding `<save>` command. Missing even ONE entry means corrupted game state. There are NO second chances - process EVERYTHING now.
