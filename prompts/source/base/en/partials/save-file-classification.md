## File Classification Rules

### File Responsibilities

| File | Recorded Content | Forbidden |
|------|------------------|-----------|
| `{{FILE_ASSETS}}` | **Protagonist-owned but NON-carried** cash, real estate / base layouts, items deposited at bases/inns or in third-party safekeeping | Carried items, magic, equipment, **NPC personal property** |
| `{{FILE_TECH_EQUIPMENT}}` | **Detailed Specs/Settings** of developed or discovered technology, equipment, tools, vehicles | Magic itself, spells, **Current Stock** |
| `{{FILE_WORLD_FACTIONS}}` | Faction dynamics, world building (see details below) | Personal quests, user plans, equipment / technical-product specs (→ `{{FILE_TECH_EQUIPMENT}}`) |
| `{{FILE_MAGIC_SKILLS}}` | Protagonist's party's **mastered, learned, or actively researched** formulas, casting process, spell logic, combat skills | Magic items, enchanted gear, **Observed NPC magic** |
| `{{FILE_PLANS}}` | Accepted quests, personal goals, progress | World events, faction dynamics |
| `{{FILE_INVENTORY}}` | **Protagonist-owned, carried** weapons, armor, consumables, materials, magical items, **cash / currency** (pocket / backpack / portable spaces — judge "carried" by setting) | Real estate, large vehicles, **Detailed Specs**, **NPC personal items** |

> **[Protagonist-Owned Only]**: `{{FILE_ASSETS}}` and `{{FILE_INVENTORY}}` record ONLY items personally owned by the protagonist. Personal property of companions, love interests, employers, hosts, and other **NPCs goes to `{{FILE_CHARACTER_STATUS}}`** under that NPC's `### Known Significant Possessions` section. Even if the protagonist is temporarily sheltered, hosted, or kept as a kept-man, the host's belongings are NOT the protagonist's possessions.

> **[Carried Criterion]**: `{{FILE_INVENTORY}}` and `{{FILE_ASSETS}}` both record protagonist-owned things; the **only** divider is whether it is carried — on-person (pocket / backpack / magical storage space and other carried containers) → `{{FILE_INVENTORY}}`; kept in a non-carried place (base, hidden cache, drawer at home, any non-carried location) → `{{FILE_ASSETS}}`. **Cash, items, and materials are treated identically — no special case**: the same coins go to `{{FILE_INVENTORY}}` when carried, `{{FILE_ASSETS}}` when stored elsewhere.

**{{FILE_BASIC_SETTINGS}}**: **Only "augmenting an existing entry" is allowed**; everything else goes to `{{FILE_WORLD_FACTIONS}}`.
- **Allowed**: Appending same-kind details under an existing entry (e.g. adding a new dish example under an existing "Culture / Cuisine" entry). `target` MUST be a verbatim fragment that **already exists** in basic settings, and `replacement` MUST **keep `target` intact as its prefix** — new content may **only** be appended after it.
- **Forbidden**: Creating new top-level sections / subheadings, rewriting or deleting existing text, reordering existing entries, splitting `target` and recomposing it.
- **`context` MUST be a heading path that already exists in BASIC_SETTINGS**. If the path is not present in basic settings, do **NOT** force a new section in — route to `{{FILE_WORLD_FACTIONS}}` instead.
- Newly discovered factions / locations / products / NPCs and other world-building expansion still go to `{{FILE_WORLD_FACTIONS}}`. BASIC_SETTINGS is only touched for **detail augmentation of existing entries**.

> [!IMPORTANT]
> **Item Archiving Absolute Rule**: Keep **possession fact** and **detailed setting** on two separate axes — do not conflate them.
> - **Possession fact**: For a physical item the protagonist currently holds, the "owns X×N" record goes by the [Carried Criterion] to `{{FILE_INVENTORY}}` (carried) or `{{FILE_ASSETS}}` (non-carried).
> - **Detailed setting routes by item nature**:
>   - **Equipment / tools / vehicles / technical products** — specs, performance, research principles → `{{FILE_TECH_EQUIPMENT}}`. **FORBIDDEN** to place such specs in `{{FILE_WORLD_FACTIONS}}` even with rich historical background; record that background in the **"Notes"** field under the item entry instead.
>   - **Faction tokens / rank insignia / sacred relics / artifacts** — fundamentally faction lore (their value is in origin and meaning, not equipment performance) → the "Key Items" scope of `{{FILE_WORLD_FACTIONS}}`, **even when held by the protagonist** (the possession record still stays in `{{FILE_INVENTORY}}` / `{{FILE_ASSETS}}`).
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
- **Key Items**: Plot-critical artifacts, relics, faction tokens / rank insignia (including ones held by the protagonist — record their origin and meaning here; the possession record stays in `{{FILE_INVENTORY}}` / `{{FILE_ASSETS}}`)
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
