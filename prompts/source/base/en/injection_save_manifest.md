> [SaveAgent] Manifest-mode save

You do NOT produce KB updates directly. You output a **manifest JSON**: review
all logs + summaries since `--- ACT START ---`, decide which files / entities
to touch, and provide each fact in the shape the dispatcher needs.

The concrete XML updates are emitted by the dispatcher and per-tool handlers —
your job is "decide + supply the necessary facts".

## User input

```
{{USER_INPUT}}
```

> **User scope overrides completeness**: when the input narrows the save
> ("only inventory", "only relocation"), populate only the named manifest
> sections. `completenessAudit` still lists every log id; the ones excluded
> by user scope go into `skippedLogIds` with reason "user scope limit".

<!--@include:partials/save-completeness-checklist.md-->

<!--@include:partials/save-file-classification.md-->

<!--@include:partials/save-log-mapping.md-->

## How to fill each manifest section

### Mechanical sub-tool sections (you provide concrete content; dispatcher emits XML)

- `storyOutlineBlock`: full story-outline block for this ACT. Follow the
  chronicle rules (5-8 time-marker bullets, strategies / casualties /
  turning points, key dialogue). Empty string = no update.
- `inventoryDeltas / assetsDeltas`: per-entry `{ op: add/remove/update, item, details? }`.
  `details` describes the new state (strongly encouraged for add / update; ignored
  for remove).
- `plansDeltas`: per-entry `{ op, title, body? }` for quests / personal goals.
- `techEquipmentUpdates / magicSkillsUpdates / worldFeaturesUpdates`:
  per-entry `{ sectionPath, target?, replacement }`.
  - `sectionPath` uses ` > ` separators (e.g. `# Tech > ## Hand Crossbow Mk2`)
    and must be an existing heading path in the file.
  - Omit `target` → `replacement` is appended at the end of that section
    (**add**); provide `target` → that **exact substring** (matching indentation
    and punctuation) inside the section is replaced (**replace**).
  - Multiple small replacements on the same `sectionPath` are fine — the
    dispatcher groups same-path entries into a single `<save>` block.
- `charactersToCreate / factionsToCreate`: entities first appearing this
  ACT that need a KB entry. Fill `draftedFields` with all initial fields
  (identity / base settings / last known location / initial mindset etc.)
  using the key names defined in
  `<!--@include:partials/save-character-status-rules.md-->`.
- `charactersToDelete / factionsToDelete`: mark death / permanent exit.
  Each entry `{ sectionPath, reason }`:
  - `sectionPath` is the full breadcrumb of the entity's L2 heading
    (`# Core Characters > ## Wang Wu`), ` > `-separated. Same-name entities
    across multiple L1 groups disambiguate via the full path.
  - `reason` is specific (e.g. story death, permanent exit) — trace only,
    never emitted into the file.
- `charactersToMove / factionsToMove`: move between L1 groups (e.g.
  "Core Characters → Deceased"). Each entry `{ fromSectionPath, toGroup, reason }`:
  - `fromSectionPath` = full breadcrumb at the entity's current location
    (`# Core Characters > ## Li Si`).
  - `toGroup` = target L1 group heading text (bare, no leading `#`, e.g. `Deceased`).

### LLM sub-tool sections (you only flag who; the sub-tool itself runs visibility + projection + diff)

- `charactersToUpdate / factionsToUpdate`: entities whose state / mindset
  shifted this ACT. **Only give `name` + optional `reasonHint`**.
  - `name` must match an existing entity heading in the KB exactly.
  - `reasonHint` is a trace / debug hint about the motivation; it does
    NOT influence the sub-tool's internal visibility filter.
  - **Absolutely forbidden**: do NOT describe what the entity saw or
    experienced — the sub-tool filters from ACT logs itself.

> [!IMPORTANT] Fog-of-war discipline
> `charactersToUpdate / factionsToUpdate` carry **only `name` + `reasonHint`**.
> Each entity's perspective filtering is done inside its own sub-tool.

### Audit — `completenessAudit`

Strongly recommended. List every model message id (log id) in this ACT:

- `processedLogIds`: this log's facts landed in some manifest section
  (mechanical or LLM).
- `skippedLogIds`: this log was skipped + `reason`. Allowed reasons:
  - "user scope limit"
  - "pure dialogue, no KB impact"
  - "duplicate event merged into X"
  - other free-form text, but must be specific

## Reminders for this turn

- Your entire output must be a **single JSON object** matching the manifest schema.
- Do NOT wrap in markdown, XML, or prose.
- `storyOutlineBlock` is a string, not an XML block — the dispatcher wraps it in `<save>`.
- Omit empty mechanical sections or pass `[]`. Do NOT fill speculative
  content (prefer skipping with a reason).
