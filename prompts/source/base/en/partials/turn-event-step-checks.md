## Per-turn `event` step checks (run in order, all mandatory)

Each turn, run the four checks below in the order ① → ② → ③ → ④; **the four are independent — finishing one does not excuse skipping the next**. **Every trigger that meets a check's condition becomes its own `kind: "event"` step**: if several items / passives / hooks each qualify this turn, emit that many steps (one step per trigger), slotting them chronologically among the `user_intent` steps they interrupt or affect.

### ① `source: "skill_item"` — passive ability / item / equipment trigger

From this turn's `user_intent` step(s) and `scene_snapshot`, judge whether a passive ability / item / equipment of **the PC or any present NPC** (per `{{FILE_BASIC_SETTINGS}}` / `{{FILE_CHARACTER_STATUS}}` / `{{FILE_MAGIC_SKILLS}}` / `{{FILE_INVENTORY}}` / `{{FILE_TECH_EQUIPMENT}}`) triggers or activates due to the current situation. **Each** ability / item / equipment that triggers or activates emits its own step with `kind: "event"` / `source: "skill_item"` / `hook_title: ""` (several firing at once → that many steps); `action` names whose ability / item / equipment fires and what effect it produces. `breaks_ideal` follows the `source: "random"` rule (neutral / supportive `false`; `true` only when it clearly interrupts the PC's step sequence).

### ② `source: "random"` — random / environmental event

Judge the current `scene_snapshot` and scene tension to decide whether to inject a third-party intervention / NPC action / environmental shift. Match the event types and positive/negative balance to the "Random Events" subsection of `[World Reaction]` (positive and negative events must be balanced — do NOT trigger only negative ones). If triggered → emit a step with `kind: "event"` / `source: "random"` / `hook_title: ""`.

### ③ `source: "hook_fire"` — story hook

For **every not-yet-fired hook** under `{{FILE_STORY_OUTLINE}}` "Story Triggers", first run **a dual "already-fired" check (any condition true → treat as fired, skip that hook)**:

- (a) **KB already marked `(Completed)`**.
- (b) **Recent turns' `summary` / `analysis.steps[]` already contain a `hook_fire` with the same `hook_title`** (in-session self-check that guards against re-firing during the window before the `(Completed)` marker lands in KB; the marker is written at the next save, not at trigger time).

For hooks that pass the check (i.e. not yet fired), evaluate the trigger condition against this turn's `user_intent` step(s) and `scene_snapshot`. If satisfied → emit a step with `kind: "event"` / `source: "hook_fire"` / `hook_title` set to the hook's verbatim title; `action` **MUST cover every item recorded under the hook in one shot** — do not split across multiple turns; `outcome` and `breaks_ideal` are judged based on the hook's content (no special override; follow the same rules as other steps).

**This check runs every turn, but only scans not-yet-fired hooks** — hooks already `(Completed)` or already fired in this session are skipped outright, not re-evaluated. Skip the whole check only when `{{FILE_STORY_OUTLINE}}` lacks a "Story Triggers" section OR every hook beneath it has already fired.

### ④ Consequence fermentation — reputation / accountability reactions (emitted as `source: "random"`)

Scan recent turns' `summary` (`[EVT]`/`[PLOT]`) for the protagonist's **formed and unsettled** consequences (exposure and each reaction rung are recorded in `[EVT]`; skip those already marked settled; threshold judgment per [World Reaction] "Action Consequences & Reputation Propagation"); also check whether minor exposed acts recurring in the same community / faction territory across the recent `[EVT]` chain have **accumulated past the tolerance line** — if so, a new consequence forms this turn. For each formed consequence:

1. Identify the affected parties per `{{FILE_WORLD_FACTIONS}}` / `{{FILE_CHARACTER_STATUS}}` — the victim's faction, local law enforcement, the community, the witnesses' social networks.
2. Judge, from the world's spread channels and the in-world time elapsed, how far the news has traveled by now and whether some party's reaction is due to arrive **this turn**.
3. Due → emit a step with `kind: "event"` / `source: "random"` / `hook_title: ""` describing that party's concrete reaction; escalate along the "Action Consequences & Reputation Propagation" reaction ladder. **Anti-repeat**: if recent summaries already record a same-rung reaction for this consequence, this turn must either stay silent or climb one rung — repeating the same rung is **FORBIDDEN**.

Minor isolated acts below the threshold emit **no** event step (the in-scene reaction was already covered by that turn's `npc_reactions`); but dismissing moderate-or-above acts, or accumulated over-the-line repeats, with "they tolerated it" is **FORBIDDEN**.

Division of labor with ②: ② covers random / environmental events causally unrelated to the protagonist's past actions and is bound by positive/negative balance; ④ is the inevitable fermentation of the protagonist's own actions and is **NOT** bound by that balance — whoever keeps doing evil and leaving witnesses gets a world full of pursuers; whoever keeps doing visible good accrues renown and returns alike.

Ordering: run ① → ② → ③ → ④. When several fire this turn, event steps follow chronological order (`skill_item` and `hook_fire` typically land immediately after the `user_intent` step that triggered them; ④'s reaction steps slot wherever the situation dictates — often at the turn's start, or right after the PC moves or appears in public).
