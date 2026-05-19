## LOG Integration Rules & State Calculation

- **[State Synchronization Rule]**: The provided files are records from before this ACT started. You MUST merge the accumulated changes **after the `--- ACT START ---` marker** (from `character_log`, `inventory_log`, `quest_log`, and `world_log`) to calculate the **"Accurate Current State"** before writing it into the file update commands (XML) below.

If the current ACT (starting from `--- ACT START ---`) has LOG content, you **MUST** automatically generate corresponding `<save>` updates:

### `inventory_log` → Target Files
- Protagonist's money change → `{{FILE_ASSETS}}`
- Protagonist-owned base / real estate acquisition or change → `{{FILE_ASSETS}}`
- Protagonist-owned but **deposited at a base / inn / third-party safekeeping** (non-carried) items → `{{FILE_ASSETS}}` under the corresponding base layout
- Protagonist's **carried (on-person)** items → `{{FILE_INVENTORY}}`

### `character_log` → `{{FILE_CHARACTER_STATUS}}`
- **First Encounter Evaluation**: If a character is encountered for the first time (not in file), you **MUST** evaluate if they are significant.
  - **Unique Name Principle**: ONLY records characters with a **unique proper name** and **substantial plot influence**.
  - **ABSOLUTE PROHIBITION**: Forbidden to record any character using generic labels, titles, or numbering (e.g., "Guard A", "Bandit B", "Random Villager", "Passerby", "Guard Member", etc.).
  - **Excluded Categories**: One-time scene NPCs, background filler characters, or NPCs providing minimal information.
- **Significance Criteria**: If the character is involved in **delivering quests, providing/requesting resources, or providing key information**, OR has a **unique name or a specific title** (e.g., "Manager XXX", "Village Head OO"), OR the **protagonist actively attempts to interact with them, asks for their name, or explicitly expresses interest**, they **MUST** be added to ensure narrative continuity.

- **Exit & Pruning Mechanism**: To prevent file bloat, proactively prune entries under these conditions:
  - **Death**: Remove from categories and move to `# Deceased Characters`.
  - **Functional Task Completed**: If a `# Secondary Characters` entry has fulfilled purpose and will not logically reappear, **proactively delete** their entry.
  - **Permanent Departure**: If a character has "permanently left the stage", move to `# Historical Figures` or delete.

- **Possession Change Handling**: Each `Possession Change:` entry in `character_log` MUST be written into the `### Known Significant Possessions` subsection under that NPC's entry, and the subsection's `**Last Updated**` line MUST be refreshed to the current turn's timestamp. If the NPC entry has no such subsection, add it in the same position as `### Core Values and Behavior Guidelines` (immediately before it).

- **Learned Capability Handling**: When `character_log` records a capability the protagonist has acquired (any skill, magic ability, sensory perception, technique, or similar trait that fits the schema of `{{FILE_MAGIC_SKILLS}}` by nature), route the entry to `{{FILE_MAGIC_SKILLS}}` as a new Magic or Skill entry per the file's schema (choose by nature: martial / weapon / movement / body technique → Skill; magical formula / sensory awareness / mana operation → Magic). **Do NOT** duplicate the entry into `{{FILE_CHARACTER_STATUS}}` — `{{FILE_MAGIC_SKILLS}}` is the canonical home for learned capabilities. If the log line names a source (typically a Story Trigger), preserve it as a `**Source**` / `**Acquired Via**` note on the new entry.

### `quest_log` → `{{FILE_PLANS}}`
- Quests/Plans
- **One-Act exclusion**: If a quest is both opened and resolved within the same ACT and has no narrative extension or follow-up, do NOT create an entry for it in this file. `{{FILE_PLANS}}` tracks ongoing multi-ACT objectives only; one-shot resolved quests are already captured in the Story Outline.
- **Pruning Mechanism**: Proactively delete items that are **completed** and have no further influence on subsequent plots to prevent file bloat.

### `world_log` → Target Files
- World events/factions/world building → `{{FILE_WORLD_FACTIONS}}`
- Protagonist's party's tech specs/blueprints development → `{{FILE_TECH_EQUIPMENT}}`
- Protagonist's party's magic & skills development → `{{FILE_MAGIC_SKILLS}}`
