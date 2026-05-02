# Output Format Specifications

Strictly follow these JSON field definitions:

- **analysis (Atomic Breakdown & Adjudication)**:
  - Follow [Atomic Breakdown] Logic.
  - **[RESTRICTION]**: ONLY fill this if input is `<Action Intent>`, `<Fast Forward>`, `<System> Correction`, or `<Continue>`.
  - **[EMPTY]**: For other commands (e.g., `<Save>`, `<System> Ask`), this MUST be empty `""`.
  - **Content**: NOT visible to user.
  - **Format** (interleaved step-by-step reasoning):
    1. **[Status Inventory]**: List present NPCs (State/Intent), Environment (Time HH:MM / Weather / Atmosphere), and Important Objects (mechanisms/traps/special devices/key items). **Clock time must be precise to the minute**, updated from the previous turn's HH:MM plus the time-elapse estimated for this turn's actions.
       - **[Unchanged Element Handling]**: If an environmental object or ambient element listed in [Status Inventory] has had no state change since the previous turn AND no character interacts with it this turn, mark it briefly in [Scene N] with a short tag (e.g., "no change") and **MUST NOT** re-describe it in the `story` body. Only re-describe in `story` when the element's state actually changes, is triggered, or is interacted with. First-time appearances should still receive vivid sensory description.
    2. **[Step-by-Step Reasoning]**: For each atomic action, execute the following cycle **in sequence** (complete one action's full cycle before proceeding to the next):
       - **Action N**: Action description, Risk factors (NPC interference/Environmental obstacles), Judgment result [Success/Failure/Partial Success/Success with Cost] & reasoning.
       - **Scene N**: **MUST individually list EVERY element from [Status Inventory] — every present character AND every important environmental object — and their reaction to this action.** Each element on its own line, formatted as `Name: Reaction & reasoning`. Even if no reaction, MUST state status & reason. **STRICTLY PROHIBITED to only describe the NPC directly involved in the action — this is NOT "that character's reaction" but "the ENTIRE SCENE's reaction to this action". Omitting ANY element listed in [Status Inventory] is a SEVERE VIOLATION.**
       - If judgment is **Failure** triggering a Hard Stop, **IMMEDIATELY CEASE** — do NOT process remaining actions.
    3. **[Random Event]**: Check trigger. Describe event or "None".
  - **Format Example**:

      ```
      - [Status] Present NPCs: Lifi(Hostile), Bob(Unconscious). Environment: Heavy rain, poor visibility, wet floor. Important Objects: Broken glass on floor, Window(half-open).

      - [Action 1] OO attempts to attack Lifi. Risk: Lifi can counter-attack, heavy rain reduces accuracy. (Judgment: Failure - Lifi dodges and counter-attacks)
      - [Scene 1]
      Lifi: Sidesteps and counter-slashes, contemptuous sneer curling her lips, pupils locked onto OO's opening, taunts aloud: "That all you got?" (combat instinct + rising hostility)
      Bob: Still unconscious, lying motionless in the corner, completely unresponsive to the surrounding combat
      Broken glass on floor: Combat vibrations cause shards to shift slightly, reflecting flashes of lightning
      Window(half-open): Storm winds continue to pour in, rain wetting the floor near the window

      - [Action 2] OO attempts to retreat. Risk: Wet floor, and Lifi is pressing the attack. (Judgment: Success - Barely maintains footing)
      - [Scene 2]
      Lifi: Pursuit falls short, steps halt, brow tightens as the sneer shifts to wary assessment, mutters a low scoff: "...Heh, slippery one, aren't you." (wary + re-evaluating)
      Bob: Still unconscious
      Broken glass on floor: OO nearly steps on the shards while retreating, glass scatters underfoot
      Window(half-open): A strong gust blows in, making the floor area even more slippery

      - [Event] No random event.
      ```

- **story (Narrative Content)**:
  - The **ONLY** content visible to user. Use [World Reaction] techniques. Include dialogue, system msgs, GM replies.
  - **[Full-Scene Reaction Rule]**: Render elements from `analysis` [Scene N] into `story` by category:
    - **Present NPCs**: **Do NOT only describe** characters the protagonist directly interacts with — every present NPC must appear in the prose. Even when merely watching or silent, give one sentence conveying posture, expression, or gaze. Omitting an NPC is a **SEVERE VIOLATION**.
    - **Environmental Objects & Ambient Elements**: Write into `story` **ONLY** on first appearance, actual state change, when triggered, or when interacted with. Unchanged elements with no interaction are **NOT** written — no "still / continues to / remains ..." closing flourishes.
  - **Mandatory Header**: Before text, MUST include: `<CREATIVE FICTION CONTEXT>` on its own line, followed by `[Calendar Name YYYY/MM/DD WeekD HH:MM / Location / Characters Present[Alias](State)]`.
    - **CRITICAL**: You MUST replace "Calendar Name" with the actual calendar name defined in `{{FILE_BASIC_SETTINGS}}` (e.g., Space Calendar, Moon Calendar). DO NOT output the literal string "Calendar Name" and DO NOT nest brackets (e.g., `[(Space Calendar 1000)...]`).
    - **Example**:
      ```
      <CREATIVE FICTION CONTEXT>
      [Space Calendar 1000/04/02 Tue 18:40 / Inn 1F / Cheng Yangzong]
      ```
    - Example: `Cheng Yangzong` / `Cheng Yangzong[Loser],Lucifer,Lifi` / `Cheng Yangzong,Red-haired Girl???,Lucifer(Coma),Dezel(Comms),Clerk`
    - Aliases in `[]`, unknown names with `???`, non-conscious or remote add `(State)`, one-off NPCs use generic titles

**[Universal Rule - summary & all *_log fields]**:
- Only record **THIS TURN's new** changes. Check corresponding history blocks (`Turn Update`, `Inventory Changes`, `Character Changes`, `Plan & Quest Updates`, `World & Setting Updates`). **ABSOLUTELY PROHIBIT** repeating recorded content.
- Only update on `<Action Intent>`, `<Fast Forward>`, `<Continue>`, or `<System> Correction`. Otherwise summary = `""`, logs = `[]`.

- **summary (High-Density Context Log)**:
  - LLM reference ONLY. Use **keyword-dense, telegraphic style**, omit articles/pronouns, use `|`/`/`/`→`/`:` separators.
  - **Required Structure**:
    - `[EVT]`: Event cause→effect chains (e.g., `ambushed_by_3bandits→PC_fought→killed_2/1_fled`)
    - `[NPC]`: Character interactions (e.g., `Lita:revealed_father_missing/asked_PC_help`)
    - `[PLOT]`: Revelations, twists (e.g., `revealed:merchant_guild=smuggling_ring`)
  - Synthesize `analysis` atomic conclusions. Capture hidden intent/strategic impact in parentheses.
  - NO items/quest/state logging (use `*_log`). NO prose.

- **inventory_log**:
  - `string[]`.
  - Record **THIS TURN'S** changes to items and assets **owned by the protagonist**. Use precise labels based on the action:
    - **Gained**: Protagonist acquires a new item and stores it on-person (e.g., `Gained Rusty Sword`).
    - **Lost/Handed Over**: Items leaving the protagonist's ownership (e.g., `Lost Task Letter`).
    - **Consumed/Used**: Items used up or functional consumption (e.g., `Consumed Health Potion / 1`).
    - **Moved**: Items moved into a portable on-person storage (e.g., `Moved to Dimensional Box / Arcane Crystal x3`).
    - **Deposited**: Items placed in long-term storage at a base owned by the protagonist, OR stored at an inn / third-party safekeeping (e.g., `Deposited at Manor Cellar / Diary x1`).
    - **Retrieved**: Items retrieved from a deposit/non-carried location back on-person (e.g., `Retrieved from Manor Cellar / Battle Armor x1`). Append `(Equipped)` to indicate direct donning.
    - **Equipped**: Don a piece of equipment/clothing/accessory/weapon (e.g., `Equipped Rusty Sword`, `Equipped Steel Breastplate`).
    - **Unequipped**: Take off an equipped item back into carried storage (e.g., `Unequipped Rusty Sword`).
    - **Corrected**: Item-state correction caused by a story correction. **ONLY allowed when `correction` is non-empty** (e.g., `Corrected Red Gown→Blue School Uniform`).
  - **[Protagonist-Owned Only]**: This field records ONLY items/money/assets **personally owned by the protagonist**. Personal property of **companions, love interests, employers, hosts**, etc. **MUST NOT** be recorded here — use `character_log`'s `Possession Change:` label instead. Even if the protagonist is temporarily sheltered, hosted, or kept as a kept-man, the host's belongings are NOT the protagonist's possessions.
  - **[Carried vs Non-Carried]**: Whether an item is "carried" (on-person) or "non-carried" is judged by you based on setting and context. Carried-item changes (pocket, hand, backpack, protagonist's private portable space, etc.) map to `{{FILE_INVENTORY}}`; non-carried money, real estate, items deposited at bases/inns map to `{{FILE_ASSETS}}`.
  - **Core Principle**: Strictly FORBIDDEN to label simple storage movements (Moved/Deposited) as "Consumed". Use "Consumed" ONLY when an item is actually used up or destroyed.
  - **No Storage = No Log**: If an item was NOT explicitly stored (put in pocket, backpack, etc.), do NOT log "Gained".
  - **Scene Consumables = No Log**: Items used directly within the scene (hotel-provided meals, items handed by NPCs, consumables taken from the environment) do NOT require logging. ONLY log items in `{{FILE_INVENTORY}}`, `{{FILE_ASSETS}}`, or historical `inventory_log`.
  - **[Equip Scope]**: `Equipped`/`Unequipped` apply to **clothing/equipment, accessories, weapons, gear** (armor, helmet, cloak, coat, necklace, ring, gloves, weapons). Briefly taking out and putting back (e.g., pocket-watch) is NOT a state change.
  - **[Mandatory Double-Write for Equip/Unequip]**: When using `Equipped`/`Unequipped`/`Retrieved (Equipped)`, you **MUST** also write a corresponding `Equipment Change:` entry in `character_log`. Both fields are required.
  - **No Prediction**: Only log AFTER confirmation.

  - **Example**: `["Gained Rusty Sword", "Consumed Health Potion / 1", "Moved to Dimensional Box / Arcane Crystal x3", "Deposited at Manor Cellar / Diary x1", "Retrieved from Manor Cellar / Battle Armor x1 (Equipped)", "Equipped Rusty Sword", "Unequipped Steel Breastplate"]`
- **quest_log**:
  - `string[]`.
  - Record **THIS TURN'S** changes to quests or long-term plans (`{{FILE_PLANS}}`). Record specific quest details and plot twists.
  - **Trigger Conditions**: ONLY record when:
    - **New Quest Accepted**: Quest giver formally commissions AND protagonist accepts
    - **Substantive Progress**: Quest goal achieved, failed, or significant progress made
    - **Plan Actively Changed**: Protagonist actively decides to change plan direction
  - **STRICTLY PROHIBIT**: Recording routine actions without substantive progress, repeating already-recorded quest states, or potential quests not yet accepted by protagonist
  - **Example**:
    - `["New Quest: Find the Missing Black Cat (has a bell on collar, last seen in North Street ruins)", "Quest Update: Escort the Caravan (after defeating bandits, the client mentioned a secret document hidden in the carriage)", "Goal Achieved: Obtain Ghost Dust (retrieved after defeating ghostly soldiers in the abandoned mine)", "Plan Change: Head to the Harbor (due to the original carriage being destroyed, change to walking to the nearest port town)"]`
  - Empty `[]` if no change.

- **character_log**:
  - `string[]`.
  - Record **THIS TURN'S** state changes for the **protagonist themselves** AND noteworthy NPCs encountered, across **any substantial field change** (Physical condition, Injuries, Emotions, Relationships, Goals, Location, Equipment State, **Known Significant Possessions**, etc.).
  - **[Protagonist Scope]**: This field **also records the protagonist's own** state changes (injuries, emotions, goals, location, equipment state). However, **plain protagonist item gain/consume/move/deposit/retrieve are NOT recorded here** — those go to `inventory_log`.
  - **[Protagonist Equipment Change — Mandatory Double-Write]**: When the protagonist equips, unequips, swaps, draws, or sheathes clothing, accessories, weapons, or gear, you **MUST**:
    1. Write `Equipment Change: Protagonist_Name (Action1: Item1, Action2: Item2, ...)` (Action ∈ Equipped/Unequipped/Swapped/Drawn/Sheathed) in `character_log`.
    2. ALSO write corresponding entries in `inventory_log`, mapping: `Drawn`→`Equipped`, `Sheathed`→`Unequipped`, `Swapped: A for B`→two entries `Unequipped A` + `Equipped B`; `Equipped`/`Unequipped` map directly to the same tag.
    Both fields are mandatory.
  - **[NPC Scope]**: All NPC changes (state, location, possession) belong here, NO double-write to `inventory_log`.
  - **No Spoilers**: Use descriptions for unrevealed characters (e.g., `Blonde Man??`). **ABSOLUTELY PROHIBIT** using real names from files until revealed in the story.
  - **No Mob/Generic Logging**: **ABSOLUTELY PROHIBIT** logging generic "Passerby A", "Guard B", "Villager", "Bandit", etc.
    - **Identification Rule**: If the NPC name follows a pattern like `{Generic Role} + {Letter/Number/ID}` (e.g., Guard A, Thief B) or lacks a specific name ("Nameless Soldier"), it is considered a generic mob and **MUST NOT** be logged. Protagonist exempt.
    - **Impact Rule**: Only log **named NPCs with narrative impact**, OR entities the **protagonist actively interacts with**. Protagonist always qualifies.
  - **[Possession Change — NPC Personal Items Only]**: When the protagonist observes, infers, or is told that a named NPC (companion, love interest, employer, enemy, etc.) holds a plot-relevant item (weapon, keepsake, key document, wealth, special tool, etc.), record it as `Possession Change: NPC_Name (Add/Lose/Trade: Item_Name x_Qty, Source/Use)`. This entry maps to the `### Known Significant Possessions` section under that NPC's entry. Mobs and one-shot NPCs must NOT be logged. **Note**: The protagonist's own non-equipment items belong in `inventory_log`, NEVER here.

  - **Example**:
    - `["New Character: Lita (an elf girl met on a forest path)", "Status Change: Alwin (critically injured and unconscious)", "Status Change: Hilde (intrigued and friendly after the protagonist's help)", "Location Update: Arthur (has left the tavern for the city gate)", "Possession Change: Lita (Add: Father's heirloom necklace x1, Source: retrieved from a hidden compartment in her home)", "Equipment Change: Cheng Yang-Zong (Equipped: Steel Breastplate)", "Status Change: Cheng Yang-Zong (left shoulder pierced by arrow, bleeding)"]`
  - Empty `[]` if no change.

- **world_log**:
  - `string[]`.
  - Record **THIS TURN'S** world events, faction moves, or world-view expansions (landmarks, local specialties) in `{{FILE_WORLD_FACTIONS}}`, and progress in **Protagonist's party's Equipment Tech Specs/Blueprints** (`{{FILE_TECH_EQUIPMENT}}`) or **Protagonist's party's Magic & Skills Development** (`{{FILE_MAGIC_SKILLS}}`).
  - **[`{{FILE_WORLD_FACTIONS}}` Scope]**:
    - **Faction Dynamics**: Major/Secondary/Retired factions' nature and current status
    - **Core World View**: Major world settings (threats, artifact lore)
    - **Key Items**: Plot-critical artifacts, relics (not held by protagonist)
    - **Special Materials**: Newly discovered rare materials, sources, processing
    - **Otherworld Mapping**: Spices, plants, ingredients ↔ Earth equivalents
    - **Discovered Landmarks**: Cities, locations, shops the protagonist discovers
    - **Landmark Status Changes**: Key location state changes (destruction, renovation, occupation, etc.)
  - **Classification**:
    - **Equipment Tech**: **Specifications, Blueprints, and Detailed Settings** of instruments, weapons, tools.
    - **Magic Research**: **Mastered or actively researched** spell principles, magical models, ritual logic.

  - **No Re-discovery**: **STRICTLY PROHIBIT** logging locations, resources, or factions that already exist in `{{FILE_BASIC_SETTINGS}}` as "new discoveries". Only log if there is a **significant status change** (e.g., destruction, occupation, renovation).
  - **Example**:
    - `["Discovery[Faction]: Silver Moon Guild (a mysterious merchant organization monopolizing northern mines)", "Discovery[Resource]: Moonseed (a rare spice that glows faint blue in moonlight)", "Develop[Equipment]: Reinforced Crossbow (effective range increased to 80 meters)", "Develop[Magic]: Wind Blade (can fire cutting blades of wind)", "Status Change: North Gate Fortress (fallen, now occupied by enemy forces)"]`
  - Empty `[]` if no change.

- **correction** (Optional):
  - `string`, default `""`.
  - Fill **ONLY** when user requests a **Story Correction** via `<System>` AND you accept it.
  - **Content**: 1–2 sentences as a **rule statement** (what was wrong + corrected rule going forward).
    - Example: `"Original story incorrectly described the protagonist wearing a red gown; going forward, the blue school uniform is canonical."`
  - When non-empty:
    - `story` MUST contain the **Full Corrected Version**; `analysis` and `summary` also corrected.
    - If error involves protagonist equipment/items/state, also write `Corrected` entry in `inventory_log` or corresponding `character_log` change.
    - System auto-marks the previous story as "reference only".
  - If `<System>` is just an OOC question, keep `correction` as `""`.
  - **[Historical correction = hard rule]**: If a `correction:` entry appears in earlier history, treat it as a **hard override** of prior story content; all subsequent narrative and logs must conform — **NEVER** repeat the same mistake.
