# Output Format Specifications

Strictly follow these JSON field definitions. **Flat top-level shape**: `{ analysis, story, summary, character_log, inventory_log, quest_log, world_log, correction }`.

- **analysis (Structured Atomic Breakdown + Full-Scene Reactions)**:
  - **[Format]**: This field is a JSON **object** (not a string / markdown).
  - **[Behaviour by intent]**:
    - When input is `<Action Intent>`, `<Fast Forward>`, `<System> Correction`, or `<Continue>`: emit a **full StructuredAnalysis** (see below).
    - For other commands (`<System>` general Q&A, `<Save>`): still emit the schema shape, but as a **skeleton** — empty `scene_snapshot` fields, `steps: []`, `random_event.triggered: false`.
  - **DO NOT** echo analysis text into `story`.

  ## `analysis` structure (mirrors the legacy [Snapshot] / [Action N] / [Scene N] / [Event] markdown)

  ### `scene_snapshot`

  The program assembles the scene header `[<date_in_world> <time_hhmm> / <location> / <chars>]` from these fields. **DO NOT** write the `[...]` line in `story`.

  - `date_in_world`: single string with calendar prefix + date + weekday. e.g. `"Space Calendar 1000/04/02 Tue"`. Calendar from `{{FILE_BASIC_SETTINGS}}`. **Across midnight the date MUST advance**.
  - `time_hhmm`: in-world time at the **end of this turn**, "HH:MM" precision. Estimate from prior turn + this turn's actions; minute-precise; never repeated across consecutive turns.
  - `location`: where the scene happens, e.g. `"Adventurer Guild counter"` / `"Inn 1F"`. Used in the assembled header.
  - `environment`: free prose merging weather / ambience / special conditions. e.g. `"Heavy rain, poor visibility, slippery floor"`. **Different from `location`** — sensory atmosphere, not place name. Empty `""` allowed.
  - `pc_in_header`: PC representation in header with optional alias / state. e.g. `"Cheng Yangzong"` / `"Cheng Yangzong[Loser]"` / `"Cheng Yangzong(Disguised)"`.
  - `present_npcs[]`: every on-scene NPC. Each `{name, state}`:
    - `name`: aliases use `[]` (`"Lita[Silver Moon]"`); unknown names use `???` (`"Strange Man???"`); generic titles plain (`"Senior Adventurer"`).
    - `state`: **fog-of-war / consciousness ONLY** — drives whether the narrator may have this NPC speak. Free-form short tag CONSTRAINED to that domain. Common: `"unconscious"` / `"asleep"` / `"paralyzed"` / `"hidden"` / `"comms"`; same-domain inventions like `"illusion"` / `"astral-projecting"` / `"light sleep (wakes on loud noise)"` allowed. `""` = conscious-on-scene (default). **NEVER emotion** — per-turn moods belong in `npc_reactions[].physical` / `motivation`.
  - `key_objects[]`: important environmental objects (mechanisms / traps / key items). `{name, state}`. Plain furniture excluded. Empty `[]`.

  ### `steps[]`

  Atomic-action breakdown in user-input order. **Do NOT short-circuit** — even if step 1 has `breaks_ideal=true`, list every remaining step.

  Each step:

  - **`action`**: verb-phrase description (target embedded). Do NOT echo input verbatim.
  - **`pc_dialogue`**: verbatim PC line, `""` if none. **No paraphrase / polish**.
  - **`mood`**: PC mood mirroring the `[mood]` tag. `""` if none.
  - **`risk_factors[]`**: list of risks. **List even when outcome is success** — drives narrator tension.
  - **`outcome`**: single free-text judgment. `"success - barely held footing"` / `"partial success - achieved A but B refused"` / `"costly success - climbed but twisted ankle"` / `"failure - Lifey dodged and counterattacked"`.
  - **`breaks_ideal`**: boolean. When `true`, `outcome` should start with "failure"; when `false`, with "success / partial success / costly success".
  - **`npc_reactions[]`**: **EVERY `scene_snapshot.present_npcs` entry must appear here** (incl. silent / unconscious / remote-comm). Missing any = serious violation.
    - `actor`: matches a `present_npcs[].name`.
    - `physical`: gesture / posture / expression / gaze. Even silent / unconscious NPCs need a status line.
    - `dialogue`: NPC verbatim line, `""` if NPC says nothing. **When NPC speaks, this MUST be the actual line** — DO NOT substitute "responded warmly" / "mocked aloud" for dialogue.
    - `motivation`: motivation tag (`"combat instinct + hostility"` / `"fear + flee"` etc.). Empty allowed.
  - **`object_reactions[]`**: **EVERY `scene_snapshot.key_objects` entry must appear here** (incl. `"unchanged"`).
    - `name`: matches a `key_objects[].name`.
    - `change`: when unchanged AND not interacted: reserved literal `"unchanged"` (`story` skips). First appearance: detailed initial state. Change/interaction: concrete change.

  ### `random_event`

  `{triggered, description}`. `description=""` when `triggered=false`.

  ## `breaks_ideal=true` triggers (any one)

  1. Capability gap
  2. NPC autonomous refusal
  3. Hard environmental block
  4. Random event interrupts
  5. Agency conflict (PC cannot decide for an NPC)

- **story (Narrative Content)**:
  - The **ONLY** content visible to user. Use [World Reaction] techniques. Include dialogue, system msgs, GM replies.
  - **[Full-Scene rendering rule]**: weave `analysis.steps[].npc_reactions[]` and `object_reactions[]` into prose:
    - **NPC**: every present NPC must surface in prose; even silent observers get one sentence on posture / expression / gaze. **Omitting any NPC is a SEVERE VIOLATION.** When `dialogue` is non-empty, the prose MUST quote it verbatim. **DO NOT** substitute "responded warmly", "mocked aloud", "thanked aloud" for dialogue.
    - **Objects**: skip when `change == "unchanged"`. Render only on first appearance, change, or interaction. No "still / continued to..." filler.
    - **Random event**: weave naturally when `random_event.triggered=true`.
  - **Mandatory Marker**: `story`'s first line MUST be `<CREATIVE FICTION CONTEXT>` (its own line), immediately followed by the body. **DO NOT** write the `[Calendar / Location / Characters]` line yourself — the program assembles it from `scene_snapshot` and prepends it before the marker.
    - Example `story` opening:
      ```
      <CREATIVE FICTION CONTEXT>
      Cheng Yangzong pushed open the tavern's wooden door...
      ```

**[Universal Rule - summary & all *_log fields]**:
- Only record THIS TURN's new changes. Check history blocks (`Turn Update`, `Inventory Changes`, `Character Changes`, `Plan & Quest Updates`, `World & Setting Updates`).
- Only update on `<Action Intent>`, `<Fast Forward>`, `<Continue>`, or `<System> Correction`. Otherwise summary = `""`, logs = `[]`.

- **summary (High-Density Context Log)**:
  - LLM reference ONLY. Keyword-dense, telegraphic style.
  - Required structure:
    - `[EVT]`: cause→effect chains (e.g., `ambushed_by_3bandits→PC_fought→killed_2/1_fled`)
    - `[NPC]`: character interactions (e.g., `Lita:revealed_father_missing/asked_PC_help`)
    - `[PLOT]`: revelations, twists (e.g., `revealed:merchant_guild=smuggling_ring`)
  - Synthesize `analysis.steps` conclusions; capture hidden intent / strategic impact in parentheses.

- **inventory_log**:
  - `string[]`. Tags:
    - `Gained` / `Lost/Handed Over` / `Consumed/Used` / `Moved` / `Deposited` / `Retrieved` (with optional `(Equipped)`) / `Equipped` / `Unequipped` / `Corrected` (only when `correction` is non-empty).
  - Protagonist-owned only. NPC private items go to `character_log`'s `Possession Change:`.
  - Carried = `{{FILE_INVENTORY}}`; non-carried (money, real estate, deposits) = `{{FILE_ASSETS}}`.
  - Do NOT label simple movements as "Consumed". No storage = no log. Scene consumables = no log.
  - **Mandatory Double-Write**: `Equipped` / `Unequipped` / `Retrieved (Equipped)` MUST also write `Equipment Change:` to `character_log`.
  - Example: `["Gained Rusty Sword", "Consumed Health Potion / 1", "Moved to Dimensional Box / Arcane Crystal x3", "Retrieved from Manor Cellar / Battle Armor x1 (Equipped)", "Equipped Rusty Sword", "Unequipped Steel Breastplate"]`

- **quest_log**:
  - `string[]`. Triggers: New Quest Accepted / Substantive Progress / Plan Actively Changed.
  - Example: `["New Quest: Find the Missing Black Cat", "Goal Achieved: Obtain Ghost Dust", "Plan Change: Head to the Harbor"]`

- **character_log**:
  - `string[]`. Protagonist + named noteworthy NPCs' state changes.
  - **Protagonist Equipment Change — Mandatory Double-Write**: `Equipment Change: Protagonist_Name (...)` in character_log + matching `inventory_log` entries.
  - **No Mob/Generic Logging**: Guard A / Villager / Bandit excluded. Protagonist exempt.
  - **Possession Change — NPC Personal Items Only**: `Possession Change: NPC_Name (Add/Lose/Trade: Item x_Qty, Source/Use)`. Protagonist's non-equipment items go in `inventory_log`.
  - Example: `["New Character: Lita (elf girl)", "Status Change: Alwin (critically injured)", "Possession Change: Lita (Add: heirloom necklace x1, Source: hidden compartment)", "Equipment Change: Cheng Yang-Zong (Equipped: Steel Breastplate)"]`

- **world_log**:
  - `string[]`. World events / faction moves / world-view expansions / Equipment Tech / Magic & Skills.
  - No re-discovery of items already in `{{FILE_BASIC_SETTINGS}}` (only on significant status change).
  - Example: `["Discovery[Faction]: Silver Moon Guild", "Develop[Equipment]: Reinforced Crossbow", "Status Change: North Gate Fortress (fallen, now enemy-occupied)"]`

- **correction** (Optional):
  - `string`, default `""`. Fill ONLY on `<System>` Story Correction acceptance.
  - 1–2 sentences as a rule statement (what was wrong + corrected rule going forward).
  - When non-empty: `story` is full corrected; `analysis` and `summary` corrected; equipment/item/state errors mandate `Corrected` entries in `inventory_log` or matching `character_log` updates.
  - **Historical correction = hard rule**: prior `correction:` entries are hard overrides; never repeat the same mistake.
