# Resolution Protocol

> User input this turn:
```
{{USER_INPUT}}
```

{{HISTORICAL_CORRECTION_RULE}}

{{IDEAL_OUTCOME_CONSTRAINT}}

## Task

Emit JSON per the resolver schema: read the player's intent + structured atomic breakdown + full-scene reactions. **Do NOT write narrative prose**.

Below, **the narration stage** means the separate narrator call that consumes your output.

## Top-level fields

| Field | Content |
|---|---|
| `ideal_outcome` | One sentence describing **what PURPOSE the user was trying to achieve this turn**. Infer this from **the recent story context** (the running plot — accepted quest, ongoing situation, NPC relationship, the last few turns) together with the user's `<Action Intent>` input — read the goal behind the action, **not a restatement of the action itself**. |
| `ideal_strength` | `perfectionist` (any deviation = failure) / `pragmatic` (partial success acceptable) / `desperate` (survival counts). Default `pragmatic`. |
| `analysis` | Structured atomic breakdown + full-scene reactions (see below). |

## `analysis` structure

<!--@include:partials/turn-scene-snapshot-fields.md-->

<!--@include:partials/turn-steps-fields.md-->

<!--@include:partials/turn-reaction-elements.md-->

<!--STATS_SECTION-->
### Numeric stats — `steps[].stat_changes`

Only when a step actually changes a stat, add a `stat_changes` entry for **each stat that changed** — and only those. Most steps change nothing, so most steps carry no `stat_changes` at all; never restate an unchanged stat, and **do not invent stats or subkeys not declared below.**

- Scalar stat, or an **existing** subkey of a map stat → use `delta`, the **signed increment** to add (e.g. `-5`, `+10`), NOT the new total. e.g. `{"key":"hp","delta":-5,"reason":"cut by a sword"}` or `{"key":"affinity","subkey":"Pete Barker","delta":10,"reason":"trust grew after fighting side by side"}`.
- A **brand-new authorized** subkey of a map stat → use `value`, the **absolute initial amount** for that new subkey. e.g. `{"key":"affinity","subkey":"Cara Loft","value":20,"reason":"a good first impression"}`.
- To change a stat's **upper / lower bound** (growth or debuff caps — e.g. a level-up raises hp's max, a grievous wound lowers it) → add `"field":"max"` (or `"min"`), and use `delta` to shift the current bound or `value` to set it outright. Lowering max below the current value drags the value down with it; raising max only opens headroom for growth. e.g. `{"key":"hp","field":"max","delta":50,"reason":"level up"}` or `{"key":"hp","field":"max","delta":-30,"reason":"lasting toll of a grievous wound"}`.
- Set exactly one of `delta` / `value` per entry. `reason` is a short justification surfaced in the log.

The program owns the running totals, clamping, and authorization — you only report each step's change. The current values below are pre-turn; apply your `delta`s on top of them.

**Stats in play (what each tracks):**

{{STATS_DEFS}}

**Per-book usage & growth guidance:**

{{STATS_RULES}}

**Current values (before this turn):**

{{PC_STATS_CURRENT}}
<!--/STATS_SECTION-->

<!--@include:partials/turn-event-step-checks.md-->

<!--@include:partials/turn-breaks-ideal-triggers.md-->

**`ideal_strength` does NOT affect step-level binary judgment**: pragmatic/desperate tolerates variance on the *overall* outcome, not on a step's binary success condition.

<!--@include:partials/turn-referee-discipline.md-->

<!--@include:partials/turn-skill-consolidation.md-->

## Don't

- ❌ Write narration (no `story` field in this schema)
- ❌ List subsequent steps after a `breaks_ideal=true` step (you must stop emitting at the breaking step)
- ❌ NPC speaks but `dialogue=""` (you must supply the verbatim line)
- ❌ Omit any `present_npcs` from `npc_reactions[]` or any `key_objects` from `object_reactions[]`
- ❌ Embed reasoning in `action` / `pc_line` (reasoning lives only in `outcome`)
- ❌ Echo the raw input verbatim (`action` is a verb-phrase rewrite; the input is already structured)
