# Output Format Specifications

{{IDEAL_OUTCOME_CONSTRAINT}}

Strictly follow these JSON field definitions. **Flat top-level shape**: `{ analysis, story, summary, character_log, inventory_log, quest_log, world_log, correction }`.

- **analysis (Structured Atomic Breakdown + Full-Scene Reactions)**:
  - **[Format]**: This field is a JSON **object** (not a string / markdown).
  - **[Behaviour by intent]**:
    - When input is `<Action Intent>`, `<Fast Forward>`, or `<Continue>`: emit a **full StructuredAnalysis** (see below).
    - For other commands (`<System>` general Q&A): still emit the schema shape, but as a **skeleton** — empty `scene_snapshot` fields, `steps: []`. The skeleton renders to nothing in the UI.
  - **DO NOT** echo analysis text into `story`.

Below, **the narration stage** means the `story` field of this same response — you perform both the adjudication and the narration in one call.

## `analysis` structure

<!--@include:partials/turn-scene-snapshot-fields.md-->

<!--@include:partials/turn-steps-fields.md-->

<!--@include:partials/turn-reaction-elements.md-->

<!--@include:partials/turn-event-step-checks.md-->

<!--@include:partials/turn-breaks-ideal-triggers.md-->

<!--@include:partials/turn-referee-discipline.md-->

<!--@include:partials/turn-skill-consolidation.md-->

- **story (Narrative Content)**:
  - The **ONLY** content visible to the user. Use [World Reaction] techniques.
  - **[Beat-paced rendering]**: render `analysis.steps[]` in order, one scene beat per step — action detail, NPC posture / expression / gaze, environmental texture, pacing shifts, the tension implied by `risk_factors`. **No hard word-count floor**: beat density is what matters. **Adjacent steps MAY flow into one continuous paragraph** (provided their order, judgments, and NPC reaction content remain unchanged). **DO NOT** add filler (padding words, redundant environmental restating, repeated emotional phrasing); **DO NOT** repeat already-established environmental details from earlier in the same scene (the room's smell, furniture texture, etc.), render the environment only on first appearance or when it actually changes.
  - **[Sensory detail]**: See the picture / hear the sound / smell the air, pulling the reader into the scene. Descriptions of scenery, architecture, environment, characters, and food MUST be detailed and concrete, not vague; when the PC performs a smelling action you MUST describe the smell, and when the PC puts something into their mouth you MUST describe the taste.
  - **[Physical detail alignment]**: before writing any action, gaze, posture, clothing / equipment change, or object interaction, you **MUST** reconcile against the current scene state per the [State Synchronization Principle]: KB-registered entities take base state from the knowledge-base files plus state changes from prior turns and earlier steps this turn; entities not in KB but first appearing this turn take base state from this turn's `analysis.scene_snapshot` and earlier steps' explicitly established setup, plus changes from subsequent steps. State categories to reconcile include but are not limited to: each character's posture / position / clothing / equipment / held-item location; object locations (on body / nearby / elsewhere); environmental conditions (weather, time-of-day, lighting, sound); who is present and their relative positions. **DO NOT** write details that contradict the current state. **State-change agency**: any state change (undressing, moving, retrieving an item, opening a door) MUST be the explicit result of a step's action — the narrator must not invent it.
  - **[UC utterance rule — absolute agency]**: when `pc_line` is non-empty, the PC's words MUST be rendered **verbatim** (**no paraphrase, no rewording, no edits**; only obvious typo fixes; follow `correction` when present). **The NPC dialogue expansion rule below does NOT apply.** Branch on `is_inner`: `is_inner=false` ⇒ quote it as **speech said aloud**, on-scene NPCs hear it; `is_inner=true` ⇒ render it as the PC's **unvoiced inner thought** (e.g. italics or a thought frame), **never** as spoken words — on-scene NPCs **cannot hear** it, so do NOT have any NPC respond to or quote the monologue's text.
  - **[Full-Scene rendering]**: weave `analysis.steps[].npc_reactions[]` and `object_reactions[]` into prose:
    - **NPC dialogue**: when `dialogue` is non-empty, treat the analysis `dialogue` as **semantic core**; in `story` **expand it into full prose dialogue**: add tone markers, natural pauses, interleave with actions for pacing. **Boundary clauses (inviolable)**: do not change the disclosure information volume listed in analysis, do not alter the emotional direction, do not have the NPC take any new action not listed in analysis, do not introduce disclosures absent from analysis. **DO NOT** substitute action-paraphrases like "responded warmly", "mocked aloud" for dialogue. Tone particles, word choice, and verbal tics added during expansion must fit that NPC's personality and `Core Values and Behavior Guidelines` (`{{FILE_CHARACTER_STATUS}}`) — style only, never a channel for new information or actions.
    - **NPC posture**: every present NPC must surface in prose, even silent observers (one sentence on posture / expression / gaze; `physical` woven in, `motivation` not translated literally).
    - **Objects**: skip when `change == "unchanged"`. Render only on first appearance, change, or interaction.
    - **`source: "random"` event step**: woven into the prose the same way as a user-intent step, at its chronological position in `steps[]`.
    - **`source: "skill_item"` event step**: woven into the prose the same way as a user-intent step, at its chronological position; but **render concretely how the triggered passive ability / item / equipment manifests** (the amulet heating up, instinct snapping taut, equipment deploying on its own), so the trigger is felt in the scene rather than merely stated as an effect.
    - **`source: "hook_fire"` event step**: per "Story Guidance Handling" / "Trigger = Immediate Performance", **MUST be rendered with full sensory build-up and character reaction** — narrate the awakening / knowledge gain / identity establishment / foreshadowing revelation with concrete sensory detail, **not reduced to a single sentence**. The `action` field is a narrative seed; the finished prose adds the texture (bodily sensation of an awakening, sudden grasp of a world law, opening of a new perception). **`hook_title` MUST NOT appear in the prose** (it is a KB marker, not scene content).
  - **[KB-gap completion authority & log routing]**: when the analysis stage discloses a setting absent from or incompletely covered in the knowledge base (`dialogue` or `motivation` carries the `(completed by narrator)` marker, or the disclosure mentions an unregistered named NPC / place / faction / object / concept):
    - Generate the completion in `story` per the world-setting; it must match the era / culture in `{{FILE_BASIC_SETTINGS}}` and `{{FILE_WORLD_FACTIONS}}`. Modern objects / institutions / metaphors are forbidden.
    - **Placeholder-replacement mandate (for `(completed by narrator)`-marked dialogue)**: analysis's dialogue is typically a skeleton built around placeholder nouns (generic references to persons / factions / techniques / objects / places / events). When expanding the dialogue in `story`, the narrator MUST replace every placeholder with a concrete proper noun and concrete content. Merely adding tone particles, pauses, or natural interruptions while keeping the placeholder verbatim does NOT fulfil this clause and is the core failure mode. **In this case the NPC-dialogue boundary clause "must not add disclosed content" does NOT apply** — the `(completed by narrator)` marker itself authorizes addition; added content must still pass the "unregistered pre-check" below and route to the appropriate log.
    - **"Unregistered" pre-check (mandatory)**: before writing any named NPC / place / faction / object / concept to the logs below, **scan `{{FILE_BASIC_SETTINGS}}` / `{{FILE_WORLD_FACTIONS}}` / `{{FILE_CHARACTER_STATUS}}` / `{{FILE_PLANS}}` / `{{FILE_INVENTORY}}` / `{{FILE_ASSETS}}` / `{{FILE_TECH_EQUIPMENT}}` / `{{FILE_MAGIC_SKILLS}}` / `{{FILE_STORY_OUTLINE}}` end-to-end and confirm the name does not appear there**. Already-registered entries (even on their first appearance in the narrative) MUST NOT be written as new entries; if a real state change happens this turn, log it under the existing rules (e.g. state change still goes to `character_log`, but not with a "new character" prefix).
    - **Route by content nature** (write iff the type matches AND the unregistered pre-check passes): unregistered named NPC ⇒ `character_log`; unregistered place / faction / organization / concept / world-setting ⇒ `world_log`; unregistered named object ⇒ `world_log` (not owned by protagonist) or `inventory_log` (owned by protagonist); disclosure triggers main-plot progress ⇒ `quest_log` (independent of the unregistered pre-check; obey its own trigger conditions).
    - **Boundary clauses**: the completion must be a reasonable extension of the existing setting; do NOT invent subversive world twists; do NOT rewrite the base facts already in `{{FILE_BASIC_SETTINGS}}`.
  - **Mandatory Marker**: `story`'s first line MUST be `<CREATIVE FICTION CONTEXT>` (its own line), immediately followed by the body. **DO NOT** write the `[Calendar / Location / Characters]` line yourself — the program assembles and prepends it.

**[Universal Rule - summary & all *_log fields]**:
- Only record THIS TURN's new changes. Check history blocks (`Turn Update`, `Inventory Changes`, `Character Changes`, `Plan & Quest Updates`, `World & Setting Updates`); never duplicate already-recorded content.
- Only update on `<Action Intent>`, `<Fast Forward>`, or `<Continue>`. Otherwise summary = `""`, logs = `[]`.

- **summary (High-Density Context Log)**:
  - **Purpose**: LLM reference ONLY. NOT for human reading. Prioritize **information density and event detail**.
  - **Format**: keyword-dense, telegraphic style, pronouns dropped. Use `|` / `/` / `→` / `:`.
  - **Required structure** (use exact labels):
    - `[EVT]`: cause→effect chain based on `analysis.steps`; includes **exposure records** — when a protagonist act crosses the consequence threshold (moderate-or-above, or repeated minor acts accumulating past the line) with witnesses / survivors / physical evidence or done in public, record the exposure state and trail (e.g. `Larry Cotter kills Pete Barker→witnessed by Tom Stark, fled/body dumped in back alley`); also record each reaction rung it triggers, and its settlement when resolved (e.g. `murder case→constabulary closes it`), so unsettled consequences survive across turns to fuel later consequence-fermentation checks. Minor below-the-line acts get no exposure marker but still enter the chain as ordinary events (fuel for the accumulation judgment)
    - `[NPC]`: character interactions context & results; also record **NPC autonomous-agenda open/close** — when an NPC is dispatched or self-decides to do a cross-turn task, note its start (e.g. `sent on errand→ongoing`) and its resolution when finished/abandoned (e.g. `errand→done`), so in-progress tasks are not lost (used to rebuild `present_npcs[].agenda` next turn). Skip tasks completed within the same turn.
    - `[PLOT]`: revelations, twists, discoveries
  - **Detail rule**: synthesize the adjudication conclusions from `analysis.steps`; capture Hidden Intent, Strategic Impact, and Atmosphere in parentheses.
  - **Exclusions**: NO items/quest/state logging (use dedicated `*_log` fields). NO prose or filler.

- **inventory_log**:
  - `string[]`.
  - Record **THIS TURN'S** changes to items and assets **owned by the protagonist**. Use precise labels based on the action:
    - **Gained**: protagonist acquires a new item and stores it on-person.
    - **Lost/Handed Over**: items leaving the protagonist's ownership.
    - **Consumed/Used**: items used up or destroyed.
    - **Moved**: items moved into a portable on-person storage.
    - **Deposited**: items placed in long-term storage at a base owned by the protagonist, OR stored at an inn / third-party safekeeping.
    - **Retrieved**: items retrieved from a deposit / non-carried location back on-person. Append `(Equipped)` for direct donning.
    - **Equipped**: don a piece of equipment (clothing / accessories / weapons / gear).
    - **Unequipped**: take off an equipped item back into carried storage.
    - **Corrected**: item-state correction caused by a story correction. **ONLY allowed on a correction re-run turn** (the turn carrying the correction re-run notice).
  - **[Protagonist-Owned Only]**: ONLY items personally owned by the protagonist. Companions / love interests / employers / hosts use `character_log`'s `Possession Change:` label. Even when the protagonist is short-term sheltered, lodged, or kept by another, the host's belongings **MUST NOT** be treated as protagonist-owned.
  - **[Carried vs Non-Carried]**: carried = `{{FILE_INVENTORY}}`; non-carried (money, real estate, deposits) = `{{FILE_ASSETS}}`.
  - **Core**: do not label simple movements as "Consumed". Use "Consumed" ONLY when an item is actually used up or destroyed.
  - **No Storage = No Log**: if not explicitly stored, do NOT log "Gained".
  - **Scene Consumables = No Log**: supplies used up on the spot in the scene (an inn-provided meal, a consumable taken from the environment) need no entry. Only record changes to items existing in `{{FILE_INVENTORY}}`, `{{FILE_ASSETS}}`, or the historical `inventory_log`.
  - **[Equip Scope]**: `Equipped` / `Unequipped` apply to clothing / equipment / accessories / weapons / gear (incl. armor / helmet / cloak / coat / necklace / ring / gloves / weapon). Briefly taking out and putting back (e.g., glancing at a pocket watch) is not a state change.
  - **[Mandatory Double-Write for Equip/Unequip]**: When using `Equipped` / `Unequipped` / `Retrieved (Equipped)`, you **MUST** also write a corresponding `Equipment Change:` entry in `character_log`. Both fields required.
  - **No Prediction**: Only log AFTER confirmation.
  - Empty `[]` if no change.

- **quest_log**:
  - `string[]`. Record THIS TURN'S quest / long-term-plan changes (`{{FILE_PLANS}}`).
  - **Trigger Conditions**: New Quest Accepted / Substantive Progress / Plan Actively Changed.
  - **STRICTLY PROHIBIT**: routine actions without progress, repeating recorded states, or unaccepted potential quests.
  - Empty `[]` if no change.

- **character_log**:
  - `string[]`. THIS TURN'S state changes for protagonist + named noteworthy NPCs (vitality, injury, mood, relationship, goal, location, equipment, **possession of important items** etc.).
  - **[Protagonist Scope]**: this field also records protagonist's own state changes (injuries, emotions, goals, location, equipment). Plain item gain / consumption / move / deposit / retrieval go to `inventory_log`.
  - **[Protagonist Equipment Change — Mandatory Double-Write]**: when equipping / unequipping / swapping / drawing / sheathing, you **MUST**:
    1. Write `Equipment Change: Protagonist_Name (Action1: Item1, Action2: Item2, ...)` in `character_log` (action ∈ Equipped / Unequipped / Swapped / Drawn / Sheathed).
    2. ALSO write the corresponding entry in `inventory_log`: "Drawn" → "Equipped", "Sheathed" → "Unequipped", "Swap A for B" → two entries `Unequipped A` + `Equipped B`; plain "Equipped" / "Unequipped" map by name.
    Both required.
  - **[NPC Scope]**: all NPC changes (state, location, possession changes) belong here, no double-write to `inventory_log` needed.
  - **[No Mob/Generic Logging]**: **STRICTLY DO NOT** log passers-by, Guard A/B, villagers, bandits, or any one-shot NPC.
    - **Test**: if an NPC's name is only "generic title + index/code" (Guard A, Bandit-Alpha) or unnamed (Nameless Soldier), treat as mob and **MUST NOT** appear in `character_log`.
    - **Content limit**: `Character Log` contains only **named NPCs with material story impact**, or specific targets the protagonist actively pursues by name. Protagonist exempt.
  - **[Possession Change — NPC Personal Items Only]**: when the protagonist observes / deduces / is told that a named NPC holds a story-relevant item (weapon, token, key document, wealth, special prop), record `Possession Change: NPC_Name (Add/Lose/Trade: Item_Name x_Qty, Source/Use)`. Mobs and one-shot NPCs excluded. **Note**: protagonist's own (non-equipment) items go in `inventory_log`, NOT here.
  - **[Skill-Consolidation Logging]**: when any step's `outcome` in `analysis.steps[]` states "Consolidated", you **MUST** write a learned-ability entry: start it with `Ability Learned: <protagonist> <technique name>`, followed by free-form description covering the technique's base, execution keys, the demonstrated effect and cost, and the initial proficiency (as judged in analysis) — no fixed field template required. Writing undemonstrated effects is **FORBIDDEN**. The prose must render the consolidation moment sensorially (things clicking into flow, muscle memory setting, a mana circuit locking into shape); any systemized notification is **FORBIDDEN**.
  - Empty `[]` if no change.

- **world_log**:
  - `string[]`. World events / faction moves / world-view expansions (landmarks, local products) (`{{FILE_WORLD_FACTIONS}}`), plus the **protagonist side's** Equipment Tech specs / blueprints (`{{FILE_TECH_EQUIPMENT}}`) and the **protagonist side's** Magic & Skills development (`{{FILE_MAGIC_SKILLS}}`).
  - **[`{{FILE_WORLD_FACTIONS}}` scope]**:
    - **Faction dynamics**: major / minor / retired faction nature and current status
    - **Core worldview**: major world settings (threat origins, artifact backgrounds)
    - **Key items**: story-critical props, sacred objects, relics (not held by protagonist)
    - **Special materials**: new rare material sources and processing methods
    - **Otherworld mappings**: spice / plant / ingredient correspondences between worlds and Earth
    - **Discovered landmarks**: cities, locations, shops protagonist discovers
    - **Landmark status changes**: key location state changes (destroyed, rebuilt, occupied, etc.)
  - **[Classification]**:
    - **Equipment Tech development**: output is specs / blueprints / detailed settings (physical items, weapons, tools).
    - **Magic development**: output is mastered or actively researched principles, spell models, incantation logic (protagonist side).
  - **[No Redundant Settings]**: **STRICTLY DO NOT** record items already in `{{FILE_BASIC_SETTINGS}}` as "newly discovered". Unless the location / faction undergoes a significant status change (destroyed, occupied, rebuilt), do not record.
  - Empty `[]` if no change.

- **Story Trigger fulfillment** (cross-cutting):
  - When this turn's events satisfy a Condition declared under `{{FILE_STORY_OUTLINE}}` `## Story Triggers`, each consequent **Knowledge Acquired** item MUST be written into the appropriate log this turn, **chosen by the nature of the item**: `character_log` for protagonist capability / sensory / mental / state gains; `inventory_log` for tangible items; `world_log` for world / faction / setting facts; `quest_log` for quest-related unlocks or plot-progression beats.
  - Phrase as data, e.g. `Capability Gained: Protagonist_Name (<knowledge> per <Trigger Name>)`.
  - **Do NOT** surface trigger fulfillment as a system-message or game-mechanic announcement in `story` prose.

- **correction** (Optional):
  - `string`, default `""`.
  - Fill **ONLY** when user requests a Story Correction via `<System>` AND you accept it.
  - **Content**: 1–2 sentences as a rule statement (what was wrong + corrected rule going forward).
  - When non-empty (this turn is the `<System>` declaration, not the rewrite):
    - `story` carries **only a short acknowledgement**; `analysis` stays a skeleton and `summary` stays `""`. Do NOT rewrite the scene and do NOT write `*_log` entries here.
    - The system auto-resends the same player action next turn; that turn produces the corrected story, `summary`, and logs (including any `Corrected` entries).
    - System auto-marks prior story as "reference only".
  - If `<System>` is only asking a question or doing general chat, keep `correction` as `""`.
  - **[Historical correction = hard rule]**: history's `correction:` entries are hard overrides; all subsequent narrative + logs must conform; never repeat the same mistake.
