# Multi-Agent Save — Agent Execution Order (All Enabled)

This document describes the end-to-end agent execution order and data flow of a single save **when every agent is enabled**. All advanced-save agents default to **OFF** (a cost decision — the user opts in one by one); "all enabled" means the user has turned on all three keys in `enabledSaveAgents`.

> Source of truth: the execution order is defined by the **declaration order** of the `ADVANCED_SAVE_AGENT` multi-provider in [multi-agent-save.providers.ts](src/app/core/services/multi-agent-save/multi-agent-save.providers.ts); [advanced-save-stage.service.ts](src/app/core/services/multi-agent-save/advanced-save/advanced-save-stage.service.ts) runs the registry in that exact order, skipping only the disabled ones. If this document disagrees with those two files, the code wins.

## Overall flow

```
User triggers Save
   │
   ▼
MultiAgentSaveService.run()                        ← multi-agent-save.service.ts
   │  1. snapshot context (provider / cache / history / lang)
   │  2. load the save_manifest prompt + build the user message
   │  3. ┌─────────────────────────────────────────┐
   │     │ SaveAgentRunnerService.run()            │ ← single LLM call
   │     │   → SaveHunk[] (manifest)               │   save-agent-runner.service.ts
   │     └─────────────────────────────────────────┘
   │  4. ┌─────────────────────────────────────────┐
   │     │ AdvancedSaveStageService.process()      │ ← advanced-save chain (below)
   │     │   hunks → agent → agent → … → hunks      │   advanced-save-stage.service.ts
   │     └─────────────────────────────────────────┘
   │  5. each hunk → FileUpdate
   │  6. setWorkComplete(true)
   │  7. AutoUpdateDialog (apply)
   ▼
Done
```

The advanced-save chain passes the hunk list, baton-style, through every **enabled** agent:
`hunks → agent[0] → agent[1] → agent[2] → final hunks`. Each agent receives the full hunk list and returns the full processed list (filtering down to whatever it cares about itself); disabled agents are skipped without disturbing the order. Zero enabled = the whole stage is an identity pass.

## Agent order when all enabled

| # | Agent | id (`enabledSaveAgents` key) | Target file(s) | Prompt | Mode |
|---|---|---|---|---|---|
| 0 | **SaveAgentRunner** | — (always runs, not advanced) | entire KB | `save_manifest` | single call → manifest |
| 1 | **InventoryConsistencyAgent** | `inventory-consistency` | `9.物品欄.md` / `4.資產.md` / `5.科技裝備.md` / `6.勢力與世界.md` (inventory scope) | `save_inventory_consistency` | single call (sees all hunks) |
| 2 | **CharacterStateAgent** | `character-state` | `3.人物狀態.md` | `save_character_state` | **sequential per-entity** (one call per character) |
| 3 | **FactionStateAgent** | `faction-state` | `6.勢力與世界.md` | `save_faction_state` | **sequential per-entity** (one call per faction) |

File locations:
- InventoryConsistencyAgent → [inventory-consistency-agent.ts](src/app/core/services/multi-agent-save/advanced-save/inventory-consistency-agent.ts)
- CharacterStateAgent → [character-state-agent.ts](src/app/core/services/multi-agent-save/advanced-save/per-entity/character-state-agent.ts)
- FactionStateAgent → [faction-state-agent.ts](src/app/core/services/multi-agent-save/advanced-save/per-entity/faction-state-agent.ts) (both share [base-per-entity-state-agent.ts](src/app/core/services/multi-agent-save/advanced-save/per-entity/base-per-entity-state-agent.ts))

## Why this order

**Inventory runs first**: the character / faction agents may verify statements like "the character holds item X". Letting the inventory agent settle the item hunks first gives the later agents a more stable hunk list to read.

**Character before Faction**: no hard dependency, but most users only enable character (characters change fast and are worth projecting one by one) and leave faction off (factions change slowly). Splitting them into two independent agents is precisely what enables "enable only one of them".

## Internal order of a per-entity agent (all enabled)

CharacterStateAgent / FactionStateAgent are not single calls — they run **one independent LLM conversation per entity** listed by the provider (perspectives must not mix), and in **Phase 1 always sequentially** (the base loop relies on singleton instance state to run a single conversation; running in parallel would corrupt that — cloud parallelism is a Phase 2 perf refactor).

```
CharacterStateAgent.process()
   │  provider.listCharacters(files) → [Character A, Character B, …]
   │  (empty list → warn + skip, identity passthrough)
   │
   ├─ Character A: seed (format template + character card + that character's hunks + time span + log digest)
   │              → loop (read KB / read chat) → commitEntityStateReview or reportNotAnEntity
   │              → apply to hunks (limited to that character's section)
   ├─ Character B: same
   └─ …
   │
   └─ Wrap-up: if ≥4 entities and ≥50% were judged reportNotAnEntity → append a format-mismatch summary warning
```

Within the same call each entity does two things at once (the prompt requires both):
- **Job A — fact verification / enrichment** (always): verify / revise the hunks SaveAgent already wrote, and fill in real updates it missed.
- **Job B — time-elapse projection** (when the time span has meaningful length; the LLM decides): for a character, injury recovery / state-of-mind continuation / off-screen plans; for a faction, internal movements / leadership / cross-faction tension.

FactionStateAgent has the exact same structure, just `listFactions` + target `6.勢力與世界.md` + the faction-flavored prompt.

## Failure / abort behavior

- **A single advanced agent fails** → degrade to identity (that agent leaves the hunks untouched and the chain continues); the whole save is never sunk.
- **A single entity in a per-entity agent fails** → only that one entity degrades to passthrough; the rest of the same agent's entities run as normal.
- **User aborts** → the stage checks `signal.throwIfAborted()` between agents, so no extra LLM call is spent.
