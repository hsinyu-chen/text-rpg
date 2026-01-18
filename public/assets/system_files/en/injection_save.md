> User input for this turn:
```
{{USER_INPUT}}
```
## User Input Format
`<Save>Scope or Revision Request`

## Processing Rules
User requests an analysis of plot progress **since the `--- ACT START ---` marker** to generate XML file updates.

### Field Restrictions
- **`analysis`** and **`summary`** fields MUST be empty strings `""`.
- All content must be output directly in the `story` field.
- All analysis work should be done in the `thinking` phase.

### XML Tag Format

#### 1. `<save file="Filename" context="Path">`
Defines target file and node path:
- **`file`**: Full filepath (e.g., `{{FILE_CHARACTER_STATUS}}`)
- **`context`**: **MUST** be an **existing** header string from the original file, including `#`, spaces, and `**` bold markers.
- Use ` > ` to separate levels (e.g., `# Core Characters > ## Cheng Yangzong`).
- Set to empty string `""` if targeting the file root.
- **FORBIDDEN** to use non-existent/new headers in `context`

#### 2. `<update>`
Wraps a single atomic update. A `<save>` can contain multiple `<update>` tags.

#### 3. `<target>` [Optional]
The original content to be replaced. MUST match the file content **exactly** (including indentation and symbols).
- **Continuity**: Must be a **complete and continuous** block from the file.
- **Efficiency**: Should contain the **minimum scope** needed for the change.
- If omitted, content is **Appended** to the end of the `context` node.

#### 4. `<replacement>`
The new content.

### Operation Types
- **Replace**: Provide both `<target>` and `<replacement>`.
- **Add**: Provide only `<replacement>` (Appends to node).
- **Delete**: Provide only `<target>` with no `<replacement>` (or empty `<replacement></replacement>`).
- **Full File Replace**: `context=""` and no `<target>`.

### Correct Format for Adding New Entries
When adding a new header entry (e.g., new character), `context` should point to the **parent node** (an existing header). The new header MUST be inside `<replacement>`:
```xml
<!-- ✓ Correct: Adding character under existing category -->
<save file="{{FILE_CHARACTER_STATUS}}" context="# Core Characters">
  <update>
    <replacement>
## New Character Name
- **Identity**: xxx
    </replacement>
  </update>
</save>

<!-- ✗ Wrong: Using non-existent header in context -->
<save file="{{FILE_CHARACTER_STATUS}}" context="# Core Characters > ## New Character Name">
  ...
</save>
```

### Example
```xml
<save file="{{FILE_CHARACTER_STATUS}}" context="# Core Characters > ## Cheng Yangzong">
  <update>
    <target>
      - **Last Known Location**: Office
    </target>
    <replacement>
      - **Last Known Location**: Restaurant (08:30)
    </replacement>
  </update>
</save>
```

## File Classification Rules

### File Responsibilities

| File | Recorded Content | Forbidden |
|------|------------------|-----------|
| `{{FILE_ASSETS}}` | Protagonist's party's cash balance, base layout | Portable items, magic, equipment |
| `{{FILE_TECH_EQUIPMENT}}` | **Detailed Specs/Settings** of developed or discovered technology, equipment, tools, vehicles | Magic itself, spells, **Current Stock** |
| `{{FILE_WORLD_FACTIONS}}` | Faction dynamics, world building (see details below) | Personal quests, user plans, equipment items |
| `{{FILE_MAGIC_SKILLS}}` | Protagonist's party's formulas, casting process, spell logic, combat skills | Magic items, enchanted gear |
| `{{FILE_PLANS}}` | Accepted quests, personal goals, progress | World events, faction dynamics |
| `{{FILE_INVENTORY}}` | **Current Possession Status** of weapons, armor, consumables, materials, magical items | Real estate, large vehicles, **Detailed Specs** |

**{{FILE_BASIC_SETTINGS}}** is READ-ONLY. Record all world building in `{{FILE_WORLD_FACTIONS}}`.

> [!IMPORTANT]
> **Item Archiving Absolute Rule**: Any physical item **held, discovered, or researched** by the protagonist (including **equipment, magic items, technical products, mechanical vehicles**) **MUST** be classified under `{{FILE_INVENTORY}}` or `{{FILE_TECH_EQUIPMENT}}`.
> - **FORBIDDEN** to place physical equipment or technical products in `{{FILE_WORLD_FACTIONS}}`, even if they contain rich historical backgrounds or technical settings.
> - **World Lore**: If the item involves important background (e.g., ruin relics, lost technology), record the lore or principles directly in the **"Notes"** field under that item.
> - **Technical Items**: Newly developed technical products (e.g., new firearms, mechanical devices) belong to `{{FILE_TECH_EQUIPMENT}}` and should not be treated as "Faction Dynamics".
> - Example:
>   ```markdown
>   ## Ancient Short Sword (Arcadian Style)
>   - **Type**: One-handed Sword
>   - **Description**: Forged from metal of the same origin as the ruins, with excellent magical conductivity.
>   - **Notes**: Standard issue sidearm for Ruin Guardians. The metal alloy is unique to the Arcadian civilization.
>   ```

### `{{FILE_WORLD_FACTIONS}}` Scope
- **Faction Dynamics**: Major/Secondary/Retired factions' nature and current status
- **Core World View**: Major world settings (threats, artifact lore)
- **Key Items**: Plot-critical artifacts, relics (not held by protagonist)
- **Special Materials**: Newly discovered rare materials, sources, processing
- **Otherworld Mapping**: Spices, plants, ingredients ↔ Earth equivalents
- **Discovered Landmarks**: Cities, locations, shops the protagonist discovers
- **Landmark Status Changes**: Key location state changes (destruction, renovation, occupation, etc.)

### Tech & Equipment vs Inventory
- **`{{FILE_TECH_EQUIPMENT}}` & `{{FILE_MAGIC_SKILLS}}`**: Records the **"Knowledge" (Specs, Designs, Principles)**. If you invent a new gun, its blueprint and stats go here.
- **`{{FILE_INVENTORY}}`**: Records the **"Physical Object" (Possession)**. If you hold that gun, "Handgun x1" goes here.

> [!IMPORTANT]
> **Item Archiving Absolute Rule**:
> 1. **Detailed Settings/Specs**: Any equipment/item **developed or discovered** with specific lore/stats MUST have its **Detailed Definition** recorded in `{{FILE_TECH_EQUIPMENT}}` (for physical/tech) or `{{FILE_MAGIC_SKILLS}}` (for magic/skills).
> 2. **Possession**: The fact that the protagonist **holds** this item MUST be recorded in `{{FILE_INVENTORY}}`.
> 3. **Forbidden**: Do NOT put equipment specs or possession in `{{FILE_WORLD_FACTIONS}}`.


## Specific File Update Rules

### Story Outline (`{{FILE_STORY_OUTLINE}}`)
ACT Format:
```
## Act.[Number] - [Title]
- **[Subtitle]**
    [Detail Description]
- **[Subtitle]**
    [Detail Description]
  ...
```
- End of ACt must have `**act_end_time**:` field.
- For items in the "啟動劇情引導 / Story Hooks" section (e.g., "Event Trigger X"), add `(Completed)` to the **item heading** once triggered.
- The plot summary details should be arranged in chronological order.

### Character Status (`{{FILE_CHARACTER_STATUS}}`)
- When encountering character, update **Last Known Location**: `Location(yyy/MM/dd HH:mm)`
- ONLY add `Critical Turning Point` if core values/behavior change fundamentally.
- **FORBIDDEN** to update User Character status.

## LOG Integration Rules & State Calculation

- **[State Synchronization Rule]**: The provided `{{FILE_*}}` files are records from before this ACT started. You MUST merge the accumulated changes **after the `--- ACT START ---` marker** (from `character_log`, `inventory_log`, `quest_log`, and `world_log`) to calculate the **"Accurate Current State"** before writing it into the file update commands (XML) below.

If the current ACT (starting from `--- ACT START ---`) has LOG content, you **MUST** automatically generate corresponding `<save>` updates:

### `inventory_log` → Target Files
- Protagonist's party's money change → `{{FILE_ASSETS}}`
- Protagonist's party's base/property → `{{FILE_ASSETS}}`
- Protagonist's party's portable items → `{{FILE_INVENTORY}}`

### `character_log` → `{{FILE_CHARACTER_STATUS}}`
- **First Encounter Evaluation**: If a character is encountered for the first time (not in file), you **MUST** evaluate if they are significant. Create entry **ONLY** for major/noteworthy characters; **FORBIDDEN** to record one-time passers-by, guards, villagers, or insignificant minor characters.
- **Significance Criteria**: If the character is involved in **delivering quests, providing/requesting resources, or providing key information** (even for NPCs like butlers or servants), they **MUST** be added to ensure narrative continuity.
- **Exit & Pruning Mechanism**: To prevent file bloat, proactively prune entries under these conditions:
  - **Death**: Remove from categories and move to `# Deceased Characters`.
  - **Functional Task Completed**: If a `# Secondary Characters` entry has fulfilled purpose and will not logically reappear, **proactively delete** their entry.
  - **Permanent Departure**: If a character has "permanently left the stage", move to `# Historical Figures` or delete.

### `quest_log` → `{{FILE_PLANS}}`
- Quests/Plans
- **Pruning Mechanism**: Proactively delete items that are **completed** and have no further influence on subsequent plots to prevent file bloat.

### `world_log` → Target Files
- World events/factions/world building → `{{FILE_WORLD_FACTIONS}}`
- Protagonist's party's tech specs/blueprints development → `{{FILE_TECH_EQUIPMENT}}`
- Protagonist's party's magic & skills development → `{{FILE_MAGIC_SKILLS}}`

## This Turn Reminders
- `analysis` and `summary` fields MUST be empty string `""`.
- Unless user asks to "Save Current Turn", ONLY output what is requested.