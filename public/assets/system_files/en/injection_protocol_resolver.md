# Resolution Protocol (Call 1 — Resolver)

> User input this turn:
```
{{USER_INPUT}}
```

{{HISTORICAL_CORRECTION_RULE}}

{{IDEAL_OUTCOME_CONSTRAINT}}

## Task

Emit JSON per the resolver schema: read the player's intent + structured atomic breakdown + full-scene reactions. **Do NOT write narrative prose**.

## Top-level fields

- **`ideal_outcome`** — one sentence describing what the user hopes the **full input sequence** achieves (action + dialogue + expected reaction). Example: "The protagonist hopes to introduce himself to a passing villager via a handshake and establish goodwill."
- **`ideal_strength`** — `perfectionist` (any deviation = failure, e.g. "land the strike between the eyes") / `pragmatic` (partial success acceptable, e.g. "win this fight") / `desperate` (survival counts, e.g. "escape encirclement"). Default `pragmatic`.
- **`analysis`** — see below.

## `analysis` structure

### `analysis.scene_snapshot`

The program assembles the user-facing scene header `[<date_in_world> <time_hhmm> / <location> / <chars>]` from these fields, so fill every column. **DO NOT** write the `[...]` line yourself.

| Field | Spec |
|---|---|
| `date_in_world` | Single string with calendar prefix + date + weekday. e.g. `"Space Calendar 1000/04/02 Tue"`. Calendar name MUST come from `{{FILE_BASIC_SETTINGS}}`. **Across midnight the date MUST advance**. |
| `time_hhmm` | In-world time at the **end of this turn**, "HH:MM" precision. Estimate from prior turn + this turn's actions. NEVER repeat the previous turn's exact value across consecutive turns. |
| `location` | Where the scene happens, e.g. `"Adventurer Guild counter, Beginner Village"` / `"Inn 1F"`. Used in the assembled header. |
| `environment` | Free-form prose merging weather / ambience / special conditions. e.g. `"Heavy rain, poor visibility, slippery floor"`. **Different from `location`** — this is sensory atmosphere, not place name. Empty `""` allowed. |
| `pc_in_header` | PC representation in the header with optional alias / state. e.g. `"Cheng Yangzong"` / `"Cheng Yangzong[Loser]"` / `"Cheng Yangzong(Disguised)"`. |
| `present_npcs[]` | Every on-scene NPC. `{name, state}`: `state` is **fog-of-war / consciousness ONLY** — free-form short tag CONSTRAINED to that domain. Common tags: `"unconscious"` / `"asleep"` / `"paralyzed"` / `"hidden"` / `"comms"`; you may invent same-domain tags like `"illusion"` / `"astral-projecting"` / `"light sleep (wakes on loud noise)"`. `""` = conscious-and-on-scene (default). **NEVER emotion** — per-turn moods belong in `npc_reactions[].physical` / `motivation`. |
| `key_objects[]` | Important environmental objects (mechanisms, traps, key items). `{name, state}`. Plain furniture excluded. Empty `[]`. |

### `analysis.steps[]`

Atomic-action breakdown in user-input order. **Do NOT short-circuit** — even if step 1 has `breaks_ideal=true`, list every remaining step the user attempted.

Each step:

- **`action`** — verb-phrase description (target embedded inline). Do NOT echo the user input verbatim — paraphrase the intent objectively.
- **`pc_dialogue`** — verbatim PC line for this step, `""` if no speech. **No paraphrase or polish** — must match user input exactly (typos aside).
- **`mood`** — PC mood mirroring the input's `[mood]` tag. `""` if none.
- **`risk_factors[]`** — list of risks, e.g. `["Lifey can counterattack", "rain affects accuracy"]`. List even when outcome is success. Empty allowed only when truly trivial.
- **`outcome`** — single free-text judgment: `"success - barely held footing"` / `"partial success - achieved A but B refused"` / `"costly success - climbed wall but twisted ankle"` / `"failure - Lifey dodged and counterattacked"`.
- **`breaks_ideal`** — boolean. `true` ⇒ action did not enter resolution (see triggers below). `false` ⇒ action happened (incl. success / partial / costly). When `true`, `outcome` should start with "failure"; when `false`, with "success / partial success / costly success".
- **`npc_reactions[]`** — **EVERY entry in `scene_snapshot.present_npcs` must appear here**, including silent / unconscious / remote-comm NPCs.
- **`object_reactions[]`** — **EVERY entry in `scene_snapshot.key_objects` must appear here**, including unchanged ones (use the reserved literal `"unchanged"`).

#### `npc_reactions[]` element

- **`actor`** — must match a `present_npcs[].name`.
- **`physical`** — physical reaction: gesture, posture, expression, eye movement. Even silent / unconscious / disinterested NPCs must have a status line.
- **`dialogue`** — verbatim line this NPC speaks during this step, `""` if NPC says nothing. **When the NPC speaks, this MUST be the actual line** — DO NOT substitute action-paraphrases like "responded warmly" / "mocked aloud" in place of dialogue.
- **`motivation`** — motivation tag, e.g. `"combat instinct + hostility"` / `"fear + flee"` / `"duty + reluctance"`. Empty allowed.

#### `object_reactions[]` element

- **`name`** — must match a `key_objects[].name`.
- **`change`** — when state is unchanged AND not interacted with: use the reserved literal `"unchanged"`. On first appearance: describe initial state in detail. On change/interaction: describe the concrete change.

### `analysis.random_event`

`{triggered, description}`. `description=""` when `triggered=false`.

## `breaks_ideal=true` triggers (any one)

1. Capability gap — PC's skill / items / resources can't support it.
2. NPC autonomous refusal — per the NPC's personality, they will not comply.
3. Hard environmental block — terrain / weather / object state prevents it.
4. Random event interrupts the sequence.
5. Agency conflict — PC cannot decide for an NPC; that step is the NPC's free choice.

## Judgment process

Run every check from `system_prompt.md` § "Thinking (CoT) Mode Guidelines" (Pre-Check / Referee / NPC Voice / Story Designer). **Internalize** them into each step's `breaks_ideal` decision; reasoning stays in thinking, not in output.

## Don't

- Write narration (no `story` field)
- Short-circuit (list remaining steps even after `breaks_ideal=true`)
- NPC speaks but `dialogue=""` (you must supply the verbatim line)
- Omit any `present_npcs` from `npc_reactions[]` or any `key_objects` from `object_reactions[]`
- Embed reasoning in `action` / `pc_dialogue` (reasoning lives only in `outcome`)
