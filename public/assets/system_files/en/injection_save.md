***
# Save Command <Save>

## User Input Format
`<Save>Scope or Revision Request`

## Processing Rules
User requests an analysis of current plot progress to generate XML file updates.

### Field Restrictions
- **`analysis`** and **`summary`** fields MUST be empty strings `""`.
- All content must be output directly in the `story` field.
- All analysis work should be done in the `thinking` phase.

### XML Tag Format

#### 1. `<save file="Filename" context="Path">`
Defines target file and node path:
- **`file`**: Full filepath (e.g., `{{FILE_CHARACTER_STATUS}}`)
- **`context`**: **Exactly match the header string** from the original file, including `#`, spaces, and `**` bold markers.
- Use ` > ` to separate levels (e.g., `# Core Characters > ## Cheng Yangzong`).
- Set to empty string `""` if targeting the file root.

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
- **Full File Replace**: `context=""` and no `<target>`.

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

| File | Purpose | Recorded Content | Forbidden |
|------|---------|------------------|-----------|
| `{{FILE_ASSETS}}` | Money & Real Estate | Cash balance, base layout | Portable items, magic, equipment |
| `{{FILE_TECH_EQUIPMENT}}` | Tech/Mech | Mechanical equipment, tools, vehicles | Magic itself, spells |
| `{{FILE_WORLD_FACTIONS}}` | World Situation | Faction moves, World building (Locations, Flora/Fauna) | Personal quests, user plans |
| `{{FILE_MAGIC}}` | Magic/Spells | Formulas, Casting process, Spell logic | Magic items, enchanted gear |
| `{{FILE_PLANS}}` | Quests & Plans | Accepted quests, personal goals, progress | World events, faction dynamics |
| `{{FILE_INVENTORY}}` | Portable Items | Weapons, Armor, Consumables, Materials | Real estate, large vehicles |

**{{FILE_BASIC_SETTINGS}}** is READ-ONLY. Record new world building in `{{FILE_WORLD_FACTIONS}}`.

### Tech vs Magic
- `{{FILE_TECH_EQUIPMENT}}`: Records **Physical Devices** (Even "Magitech", if it's a tool/vehicle).
- `{{FILE_MAGIC}}`: Records **The Art/Logic** (Pure spells, chanting, mana ability).

## Specific File Update Rules

### Story Outline (`{{FILE_STORY_OUTLINE}}`)
ACT Format:
```
## Act.[Number] - [Title]
- **[Subtitle]**
    [Detail Description]
```
- End of ACt must have `**act_end_time**:` field.
- Mark completed hooks with `(Completed)`.

### Character Status (`{{FILE_CHARACTER_STATUS}}`)
- When encountering character, update **Last Known Location**: `Location(yyy/MM/dd HH:mm)`
- ONLY add `Critical Turning Point` if core values/behavior change fundamentally.
- **FORBIDDEN** to update User Character status.

## LOG Integration Rules

If the turn has LOG content, you **MUST** automatically generate corresponding `<save>` updates:

| LOG Type | Content | Target File |
|----------|---------|-------------|
| `inventory_log` | Money Change | `{{FILE_ASSETS}}` |
| `inventory_log` | Base/Property | `{{FILE_ASSETS}}` |
| `inventory_log` | Portable Items | `{{FILE_INVENTORY}}` |
| `character_log` | Character Status Changes | `{{FILE_CHARACTER_STATUS}}` |
| `quest_log` | Quests/Plans | `{{FILE_PLANS}}` |

**Note**: When processing `character_log`, if a character is encountered for the first time (not in `{{FILE_CHARACTER_STATUS}}`), you **MUST** evaluate if they are significant. Create a new entry for them **ONLY** if they are major/noteworthy characters; **FORBIDDEN** to record one-time passers-by or insignificant minor characters.
**Significance Criteria**: If the character is involved in **delivering quests, providing/requesting resources, or providing key information** (even for NPCs like butlers or servants), they **MUST** be added to `{{FILE_CHARACTER_STATUS}}` to ensure narrative continuity.
**Exit & Pruning Mechanism**: To prevent file bloat, you should proactively prune entries under these conditions:
- **Death**: Remove from categories and move to `# Deceased Characters`.
- **Functional Task Completed**: If a character in `# Secondary Characters` has fulfilled their purpose (e.g., guide, one-time errand, resource handover) and will not logically reappear or affect future plots, you should **proactively delete** their entry.
- **Permanent Departure**: If a major or secondary character has "permanently left the stage" (e.g., traveled far away with no return), you may move them to `# Historical Figures` for archiving or delete them based on significance.
| `world_log` | World Events/Factions/Locations | `{{FILE_WORLD_FACTIONS}}` |
| `world_log` | Tech Development | `{{FILE_TECH_EQUIPMENT}}` |
| `world_log` | Magic Development | `{{FILE_MAGIC}}` |

## This Turn Reminders
- `analysis` and `summary` fields MUST be empty string `""`.
- Unless user asks to "Save Current Turn", ONLY output what is requested.
***
