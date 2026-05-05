# Resolution Protocol (Call 1 — Resolver / Local)

> User input this turn:
```
{{USER_INPUT}}
```

{{HISTORICAL_CORRECTION_RULE}}

{{IDEAL_OUTCOME_CONSTRAINT}}

## Output (resolver schema)

Top-level fields:

| Field | Content |
|---|---|
| `ideal_outcome` | One sentence on what the user wants the **full input sequence** to achieve (action + dialogue + expected reaction). Example: "The protagonist hopes to introduce himself via a handshake greeting and establish goodwill." |
| `ideal_strength` | `perfectionist` (any deviation = failure) / `pragmatic` (partial success acceptable) / `desperate` (survival counts). Default `pragmatic`. |
| `analysis` | Structured atomic breakdown + full-scene reactions (see below). |

## `analysis` structure

Mirrors 1-call's Snapshot / Action N / Full-Scene N / Event format.

### `analysis.scene_snapshot`

The program assembles the scene header `[<date_in_world> <time_hhmm> / <location> / <chars>]` from these fields. **DO NOT** write the `[...]` line yourself in `story`.

| Field | Spec |
|---|---|
| `date_in_world` | Single string with calendar prefix + date + weekday. e.g. `"Space Calendar 1000/04/02 Tue"`. Calendar from `{{FILE_BASIC_SETTINGS}}`. **Across midnight the date MUST advance**. |
| `time_hhmm` | In-world time at **end of this turn**, "HH:MM" precision. **Minute-precise**, not repeated across consecutive turns. |
| `location` | Where the scene happens, e.g. `"Adventurer Guild counter"` / `"Inn 1F"`. Used in the assembled header. |
| `environment` | Free prose merging weather / ambience / special conditions. e.g. `"Heavy rain, poor visibility, slippery floor"`. **Different from `location`** — this is sensory atmosphere. Empty `""` allowed. |
| `pc_in_header` | PC representation in header with optional alias / state. e.g. `"Cheng Yangzong"` / `"Cheng Yangzong[Loser]"` / `"Cheng Yangzong(Disguised)"`. |
| `present_npcs[]` | Every on-scene NPC. Each `{name, state}`:
| | • `name`: aliases use `[]` (`"Lita[Silver Moon]"`); unknown names use `???` (`"Strange Man???"`); generic titles plain (`"Senior Adventurer"`).
| | • `state`: **fog-of-war / consciousness ONLY** — drives whether the narrator may have this NPC speak. Free-form short tag CONSTRAINED to that domain. Common: `"unconscious"` / `"asleep"` / `"paralyzed"` / `"hidden"` / `"comms"`; same-domain inventions like `"illusion"` / `"astral-projecting"` allowed. `""` = conscious-on-scene (default). **NEVER emotion** — per-turn moods belong in `npc_reactions[].physical` / `motivation`. |
| `key_objects[]` | Important environmental objects. `{name, state}`. Plain furniture excluded. Empty `[]`. |

### `analysis.steps[]`

Atomic breakdown in user-input order. **Do NOT short-circuit** — even if step 1 has `breaks_ideal=true`, list every remaining step. Truncation is the program's job.

| Field | Content |
|---|---|
| `action` | Verb phrase ("walks to plaza center", "tries to attack Lifey"). Target embedded inline. **Do NOT echo the input verbatim**. |
| `pc_dialogue` | PC's verbatim line for this step, `""` if none. **No paraphrase or polish**. The narrator never sees the original input and depends on this field. |
| `mood` | PC mood (mirrors the `[mood]` tag): `"calm"` / `"tense"` / `"playful"` etc. `""` if none. |
| `risk_factors[]` | Risks, e.g. `["Lifey can counterattack", "rain affects accuracy"]`. **List even when outcome is success** — drives narrator tension. Empty `[]` only when truly trivial. |
| `outcome` | Single free-text judgment: `"success - barely held footing"` / `"partial success - achieved A but B refused"` / `"costly success - climbed but twisted ankle"` / `"failure - Lifey dodged and counterattacked"`. |
| `breaks_ideal` | Boolean. **Sole** truncation trigger. `true` ⇒ action did not enter resolution (see triggers). `false` ⇒ action happened (incl. success / partial / costly). When `true`, `outcome` should start with "failure"; when `false`, with "success / partial success / costly success". |
| `npc_reactions[]` | **EVERY `scene_snapshot.present_npcs` entry must appear here** (incl. silent / unconscious / remote-comm). |
| `object_reactions[]` | **EVERY `scene_snapshot.key_objects` entry must appear here** (incl. `"unchanged"`). |

#### `npc_reactions[]` element

| Field | Content |
|---|---|
| `actor` | Must match a `present_npcs[].name`. |
| `physical` | Gesture / posture / expression / gaze. Even silent / unconscious NPCs need a status line ("still slumped in the corner, unconscious"). |
| `dialogue` | NPC's verbatim line for this step. `""` if NPC says nothing. **When the NPC speaks, this MUST be the actual line** — DO NOT substitute action-paraphrases like "responded warmly" / "mocked aloud" in place of the line. The narrator quotes this verbatim. |
| `motivation` | Motivation tag, e.g. `"combat instinct + hostility"` / `"fear + flee"` / `"duty + reluctance"`. `""` allowed. |

#### `object_reactions[]` element

| Field | Content |
|---|---|
| `name` | Must match a `key_objects[].name`. |
| `change` | When unchanged AND not interacted with: reserved literal `"unchanged"` (narrator skips it). First appearance: detailed initial state. Change / interaction: concrete change ("battle vibration shifts the shards slightly"). |

### `analysis.random_event`

`{triggered, description}`. `description=""` when `triggered=false`.

## `breaks_ideal=true` triggers (any one)

1. Capability gap
2. NPC autonomous refusal
3. Hard environmental block
4. Random event interrupts
5. Agency conflict (PC cannot decide for an NPC)

## Don't

- ❌ Write narration (no `story` field)
- ❌ Short-circuit — list remaining steps after a break
- ❌ NPC speaks but `dialogue=""` (you must supply the verbatim line)
- ❌ Omit any `present_npcs` from `npc_reactions[]` or any `key_objects` from `object_reactions[]`
- ❌ Reasoning in `action` / `pc_dialogue` (it lives in `outcome` only)
- ❌ Echo the raw input (already structured)
