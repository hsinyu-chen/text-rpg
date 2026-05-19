## File Classification Rules

### File Responsibilities

| File | Recorded Content | Forbidden |
|------|------------------|-----------|
| `{{FILE_ASSETS}}` | **Protagonist-owned** cash, real estate / base layouts, items deposited at bases/inns or in third-party safekeeping (non-carried) | Carried items, magic, equipment, **NPC personal property** |
| `{{FILE_TECH_EQUIPMENT}}` | **Detailed Specs/Settings** of developed or discovered technology, equipment, tools, vehicles | Magic itself, spells, **Current Stock** |
| `{{FILE_WORLD_FACTIONS}}` | Faction dynamics, world building (see details below) | Personal quests, user plans, equipment items |
| `{{FILE_MAGIC_SKILLS}}` | Protagonist's party's **mastered, learned, or actively researched** formulas, casting process, spell logic, combat skills | Magic items, enchanted gear, **Observed NPC magic** |
| `{{FILE_PLANS}}` | Accepted quests, personal goals, progress | World events, faction dynamics |
| `{{FILE_INVENTORY}}` | **Protagonist-owned, carried** weapons, armor, consumables, materials, magical items (pocket / backpack / portable spaces — judge "carried" by setting) | Real estate, large vehicles, **Detailed Specs**, **NPC personal items** |

> **[Protagonist-Owned Only]**: `{{FILE_ASSETS}}` and `{{FILE_INVENTORY}}` record ONLY items personally owned by the protagonist. Personal property of companions, love interests, employers, hosts, and other **NPCs goes to `{{FILE_CHARACTER_STATUS}}`** under that NPC's `### Known Significant Possessions` section. Even if the protagonist is temporarily sheltered, hosted, or kept as a kept-man, the host's belongings are NOT the protagonist's possessions.

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
- **`{{FILE_MAGIC_SKILLS}}`**: Records the **"Learned Capability"**. If the protagonist masters a spell or weapon technique, it goes here.
- **Observed Magic/World Settings**: If a spell is only **observed** (used by an NPC) or discovered as lore but NOT learned, it goes to **`{{FILE_WORLD_FACTIONS}}`** (under Core World View or Faction dynamics).
- **Physical Media**: A magic scroll or book that hasn't been learned yet goes to **`{{FILE_INVENTORY}}`**.

> [!IMPORTANT]
> **Archiving Absolute Rules**:
> 1. **Detailed Settings/Specs**: Any equipment/item **developed or discovered** with specific lore/stats MUST have its **Detailed Definition** recorded in `{{FILE_TECH_EQUIPMENT}}`.
> 2. **Learned Skills**: ONLY record spells and skills that the protagonist's party has **actually mastered, learned, or is actively researching**.
> 3. **Possession**: The fact that the protagonist **holds** a physical item MUST be recorded in `{{FILE_INVENTORY}}`.
> 4. **Forbidden**: Do NOT put learned skills in `{{FILE_WORLD_FACTIONS}}`. Do NOT put observed NPC magic in `{{FILE_MAGIC_SKILLS}}`.
