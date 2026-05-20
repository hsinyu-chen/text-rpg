> [SaveAgent] Manifest-mode save (1-call mode: main LLM covers everything)

You do NOT produce KB updates directly. You output a **manifest JSON**: review
all logs + summaries since `--- ACT START ---`, decide which files / entities
to touch, and provide each fact in the shape the dispatcher needs.

The concrete XML updates are emitted by the dispatcher — your job is
"decide + supply concrete content". In this mode you have full information,
and **all entity field updates land in the manifest you write directly**
(there is no downstream sub-agent).

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

### Fully mechanical sections (you provide concrete content; dispatcher emits XML)

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
  using the key names defined in the character-status rules below.
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

### Existing-entity field updates — `charactersToUpdate / factionsToUpdate`

Existing entities whose state / mindset / position / relationship / goal
shifted this ACT. Each entry `{ name, reasonHint?, updates }`:

- `name` = bare L2 heading text (e.g. `Li Si`), trace only.
- `reasonHint` is optional; trace only.
- `updates` = `SectionUpdate[]`, **required, at least one entry**. Same
  shape as `techEquipmentUpdates`:
  - Each entry `{ sectionPath, target?, replacement }`.
  - `sectionPath` uses ` > ` separators and **must start with the L1 group
    + L2 entity heading** (e.g. `# Core Characters > ## Li Si`); to edit a
    sub-section within the entity, extend further
    (`# Core Characters > ## Li Si > ### Turning Points`).
  - Rules mirror `techEquipmentUpdates`: omit `target` to append at section
    end; provide `target` for exact-substring replacement.
  - Multiple changes inside one entity = multiple SectionUpdate entries
    (e.g. updating both "current mindset" and "last known location" → two
    entries on the same entity).

Field-level rules for the updates payload:

<!--@include:partials/save-character-status-rules.md-->

### Audit — `completenessAudit`

Strongly recommended. List every model message id (log id) in this ACT:

- `processedLogIds`: this log's facts landed in some manifest section.
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
- `charactersToUpdate / factionsToUpdate` entries MUST carry a concrete
  `updates` payload — an empty array or `name`-only entry is invalid in 1-call mode.
