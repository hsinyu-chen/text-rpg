---
name: dev-bridge
description: Drive a running TextRPG dev build through the BridgeServer relay via its native MCP tools. Use when the user wants to test prompts/engine changes by sending actions, listing chat state, or deleting+retrying a turn — anything like "send a turn via the bridge", "drive the app", "test through the relay", "delete that pair and retry". Skip for in-app UI testing or any change unrelated to live LLM turns.
---

# dev-bridge — drive TextRPG via the MCP relay

The relay's agent-facing surface is a native **MCP-over-HTTP server**. You drive the app by
calling MCP tools — there is no PowerShell helper layer anymore. Every tool is exposed under
the `dev-bridge` MCP server, so it is invoked as `mcp__dev-bridge__<toolname>`
(e.g. `mcp__dev-bridge__send`, `mcp__dev-bridge__list`).

## Setup — preconditions (what to do if the bridge isn't installed)

This skill drives the app entirely through the `dev-bridge` MCP server's tools
(`mcp__dev-bridge__<tool>`) — you never type an endpoint URL; Claude Code routes each call via the
registered server. The tools are **deferred**: use ToolSearch (`select:send,list,…` or a keyword
query) to load a tool's schema before its first call (calling one blind fails schema validation).

**If the `mcp__dev-bridge__*` tools don't exist, the bridge isn't installed — do NOT guess a URL.**
Tell the user how to set it up:

1. **Run the relay** — a small .NET server, repo
   [text-rpg-test-bridge](https://github.com/hsinyu-chen/text-rpg-test-bridge). The user deploys it
   (e.g. an always-on Docker container) and sets the `BRIDGE_MCP_TOKEN` env var — the relay refuses
   to start without it.
2. **Register the MCP server** — add a local, gitignored `.mcp.json` at the repo root with a
   `dev-bridge` server pointing at the relay's `/mcp` endpoint and an `Authorization: Bearer <token>`
   header matching `BRIDGE_MCP_TOKEN`; restart the session so the tools resolve.
3. **Connect the app** — in the running TextRPG dev build, Settings → Debug Bridge: set the URL to
   the relay's `/app` WebSocket endpoint, toggle on, confirm the status indicator is **green**.

JSON-RPC carries UTF-8 natively, so non-ASCII (CJK) input goes through cleanly — no encoding step to
corrupt it.

## Multi-client routing

The relay accepts multiple connected app instances (e.g. desktop + laptop + Tauri build), each
identified by the `clientId` it sends in its `hello` frame. **Every tool takes an optional
`clientId` parameter:**

- Omit `clientId` to auto-route when exactly one app is connected.
- Pass `clientId` to target a specific app.
- With multiple apps connected and no `clientId`, the call returns `client_id_required` plus the
  list of available ids — read it, then re-call with the right one.
- Targeting a client that isn't connected returns `client_not_connected`.

`mcp__dev-bridge__clients` lists the currently-connected clientIds for disambiguation.

If you see `app_not_connected`, the user's app isn't attached — pause and tell them to flip the
Debug Bridge toggle / open the app. Do not retry blindly.

## Common workflows

### Sanity check what's loaded

`mcp__dev-bridge__list` returns a per-message **digest** of the trailing messages. `limit` defaults
to **5** (capped 200 app-side); `offset` pages OLDER messages (skip that many from the tail before
taking `limit`). There is **no `full` mode** — heavy bodies live behind `read_message`.

```
mcp__dev-bridge__list { "limit": 5 }
mcp__dev-bridge__list { "limit": 5, "offset": 5 }   # the previous page of 5
```

Each digest carries `id`, `role`, `intent`, `summary` ([EVT] / [NPC] / [PLOT] telegraphic line),
the `character_log` / `inventory_log` / `world_log` / `quest_log` fields, and — for model messages
that changed numeric stats — `stat_delta` (the ground-truth post-clamp applied audit) plus
`stat_triggered` (fired stat events). It deliberately DROPS `content`, `analysis`, and `thought`.

The response also carries `total` (full history length), `offset` (echoed), and `truncated`. When
the assembled page exceeds the soft byte cap (~8000 chars) the page is trimmed from its OLDEST end
(the newest digests are always kept) and `truncated: true`. Paging is cursor-style: advance `offset`
by the number of messages actually returned (not by `limit`), so trimmed-older digests resurface on
the next page with no gap.

To read the heavy fields of one message, use `read_message` with the id from a digest:

```
mcp__dev-bridge__read_message { "id": "<id-from-list>" }
mcp__dev-bridge__read_message { "id": "<id>", "fields": ["content"] }
```

`read_message` returns only the requested heavy fields (`content` / `analysis` / `thought`; all
three when `fields` is omitted). `not_found` comes back if the id isn't in the active history.
`content` is the full scene (incl. the `<CREATIVE FICTION CONTEXT>` header); `analysis` is the
resolver pass (【現況盤點】/【動作N】/【全場景N】/【事件】 etc); `thought` is the model's CoT.

### Reload the running app

After editing prompt assets in `public/assets/system_files/**/*.md`, the running app still holds
the old text — those files are fetched once at init. Trigger a hard refresh:

```
mcp__dev-bridge__reload {}
```

The app acks then reloads, so its WS drops mid-flight (expected). After ~2 s the WS reconnects and
`list` works again. Use this any time you change `system_prompt.md` / `injection_*.md` and want to
verify behavior on the live app without asking the user to F5.

### Drive one action turn

The `userInput` action format is `([心境]動作)台詞` — emotion in brackets, then the physical
action, then the spoken line. The engine prepends the `<行動意圖>` tag itself, so do not include
it.

```
mcp__dev-bridge__send { "userInput": "([好奇]張望)這裡是哪？", "intent": "action" }
```

The response carries the produced user/model pair — `pair.model.summary` (one-line story summary),
`pair.model.content` (the full scene), the `character_log` / `inventory_log` / `quest_log` /
`world_log` fields, `pair.model.stat_delta` (post-clamp applied stat audit, present only when the
turn changed stats), and `messageId` (use this id to delete/retry). The model's CoT (`thought`) and
resolver pass (`analysis`) are **not** in the pair — fetch them via `read_message { "id": messageId }`.

`intent` is one of `action` (default) / `continue` / `fast_forward` / `system`; any other value
falls back to the engine default. There is **no `save` intent**. `continue` accepts an empty
`userInput`; `action` / `fast_forward` / `system` ignore an empty string and produce no pair.

### Delete a turn and retry

`alsoDeletePair` defaults to true — passing a model id removes it plus the user message right
before it (and vice versa). Use this whenever the model output isn't what you wanted and you want
to re-run with a tweaked prompt or different input.

```
mcp__dev-bridge__delete { "messageId": "<id-from-send>" }
mcp__dev-bridge__send { "userInput": "([緊張]說)等一下，先別走", "intent": "action" }
```

Pass `"alsoDeletePair": false` to remove only one side (rare).

### Read the active book's KB files

When debugging save-XML output, prompt-grounding issues, or anything that depends on what the
engine currently sees as world state, fetch the loaded knowledge-base files directly — same
content the engine reads, no IndexedDB / disk-sync detour.

```
mcp__dev-bridge__kb_list {}
mcp__dev-bridge__kb_read { "filename": "6.Factions_and_World.md" }
mcp__dev-bridge__kb_read { "filename": "6.Factions_and_World.md", "offset": 2000, "length": 2000 }
```

`kb_read` returns a **head slice** by default (first `KB_READ_HEAD_CHARS` = 2000 chars), not the
whole file — worldbooks were the worst context offender. Page the rest with `offset` (start char
index) + `length` (char count from offset, default 2000). The response carries `content` (the
slice), `offset`, `length` (returned slice length), `truncated` (true when more remains past the
slice), `totalSize` (full char count), and `totalTokens` (the file's token count, or null).

To LOCATE a term without dumping the file, use `kb_grep`:

```
mcp__dev-bridge__kb_grep { "filename": "6.Factions_and_World.md", "pattern": "王大福" }
mcp__dev-bridge__kb_grep { "filename": "...", "pattern": "派系", "context": 2, "maxMatches": 10 }
```

`kb_grep` searches one loaded file with a JS regex and returns `matches[]` (`{ line, text }`,
1-based line numbers), `totalMatches`, and `truncated`. `context` adds ± surrounding lines per match
(default 0); `maxMatches` caps the returned ranges (default 20, `truncated: true` when more existed).
`not_found` for an unknown filename, `invalid_pattern` for a bad regex. Then read targeted ranges
via `kb_read` offset/length.

`kb_list` returns the in-memory `state.loadedFiles` map (filename + size + tokenCount), so it
reflects edits made through the File Viewer / file-agent without a save. `not_found` comes back if
the filename doesn't match any loaded entry — filenames are language-bucketed
(`2.Story_Outline.md` vs `2.劇情綱要.md`), so check the list first if unsure.

This surface is **read-only** — there is no KB-write tool, because KB writes already have a richer
in-app path (File Viewer Monaco editor, `<Save>` auto-update flow, file-agent `searchReplace`). The
bridge isn't the right surface for blind in-place edits.

### Edit prompt rows directly (canonical AI A/B path)

The right primitive for AI-driven prompt-tuning A/B is direct IDB read/write — no disk, no FSA, no
permission dialogs, no per-session manual seed. `mcp__dev-bridge__profile_set_prompt` mutates the
active profile's IDB row via `InjectionService.saveToService`, which updates the
`prompt_user_modified` KV flag and refreshes the in-memory signal, so the next turn picks up the
edit without a heavy full reload. `mcp__dev-bridge__profile_get_prompt` reads any profile by id
(defaults to active) — useful for diffing user-defined against built-in.

```
mcp__dev-bridge__profile_get_prompt { "promptType": "system_main" }
mcp__dev-bridge__profile_get_prompt { "promptType": "system_main", "offset": 2000, "length": 2000 }
mcp__dev-bridge__profile_set_prompt { "promptType": "system_main", "content": "<newText>" }
mcp__dev-bridge__send { "userInput": "...", "intent": "action" }
```

`profile_get_prompt` returns a **head slice** (first `PROFILE_PROMPT_HEAD_CHARS` = 2000 chars) by
default — same convention as `kb_read`. Page with `offset` + `length`; the response carries
`content` (the slice), `offset`, `length`, `truncated`, `totalSize`, and `hasOverride`.

Compare across profiles with an explicit `profileId`:

```
mcp__dev-bridge__profile_get_prompt { "promptType": "system_main", "profileId": "cloud" }
mcp__dev-bridge__profile_get_prompt { "promptType": "system_main" }   # active = user-defined clone
```

`mcp__dev-bridge__profile_get_all_prompts` returns every prompt row in one call. By default it
returns per-type **meta only** (`{ length, hasOverride }`) so the call never dumps every resolved
body — pass `include: true` to get the full `{ content, hasOverride }` per type.

```
mcp__dev-bridge__profile_get_all_prompts {}                  # meta: length + hasOverride per type
mcp__dev-bridge__profile_get_all_prompts { "include": true } # full bodies
```

**Valid `promptType` values are the keys returned by `profile_get_all_prompts`** — that response is
the authoritative, non-rotting list (currently 16 types, including 6 `save_*` variants, and
notably **no plain `save`**). Do not hardcode an enum; read the keys.

**`profile_set_prompt` writes only the ACTIVE profile, and the profile must be user-defined.**
Built-in profiles (`cloud` / `local`) are read-only via this path — set returns `builtin_profile`.
Clone via Profile Management and switch active to the clone to tune. Set refuses mid-turn (`busy`);
get is always available.

**`content` is the resolved prompt** the engine actually renders for that profile — the custom IDB
override when present, otherwise the shipped base asset read on demand. So reading a built-in
profile returns its real text, not an empty string.

**`hasOverride`** distinguishes "this profile has its own IDB row for this type" (true) from "this
profile is reading the shipped base" (false). Useful for confirming a `profile_set_prompt` landed,
and for diffing customized vs default state.

### Inspect / change profile + engine config

When verifying which prompt profile is active, switching profiles, or toggling `engineMode` from
outside the UI:

```
mcp__dev-bridge__profile_active {}                  # id + displayName + isBuiltIn + baseProfileId + compat
mcp__dev-bridge__profile_list {}                    # built-in + user, each with compat tag
mcp__dev-bridge__profile_switch { "id": "cloud" }   # switch active

mcp__dev-bridge__config_get {}                                 # full AppConfigShape snapshot + modelId
mcp__dev-bridge__config_set { "engineMode": "two-call" }       # toggle two-call mode
mcp__dev-bridge__config_set { "outputLanguage": "default" }    # partial patch — only listed fields sent
mcp__dev-bridge__config_set { "fontSize": 18, "fontFamily": "serif" }
```

`config_set` is a partial patch over `AppConfigShape` — settable fields are `engineMode`,
`outputLanguage`, `fontSize`, `fontFamily`, `screensaverType`, `currency`, `enableConversion`,
`idleOnBlur`, `enableAdultDeclaration`, `exchangeRate`, `interfaceLanguage`, `smartContextTurns`.
The handler is a per-field validator: unknown keys or wrong types come back under `rejected` in the
response instead of being silently dropped. It refuses mid-turn (`busy`). `apiKey` / `modelId` /
thinking levels are NOT in scope — those live on the active LLM profile, not on `AppConfigShape`.

`compat` is `'compatible'` when the profile's `system_main` carries the current
`@system-main-version` marker, `'legacy'` for pre-PR-#28 forks. Legacy profiles auto-switch to
default at turn time (with a snackbar) — driving turns on a legacy profile via `send` will silently
land on default.

### Switch the LLM profile (model + API endpoint)

The prompt profile (`profile_switch`) selects which **prompts** the engine uses; the **LLM
profile** selects which **model + API endpoint** it calls (local llama.cpp vs Gemini / OpenAI /
etc). These are separate axes — switch one without the other to isolate which variable matters.

```
mcp__dev-bridge__llm_active {}                              # id + name + provider + modelId + isLocal
mcp__dev-bridge__llm_list {}                                # all LLM profiles with isLocal flag
mcp__dev-bridge__llm_switch { "id": "<local-profile-id>" }                       # local → free, no guard
mcp__dev-bridge__llm_switch { "id": "<gemini-profile-id>", "confirmPaid": true } # paid → requires flag
```

**Paid model guard**: switching to any non-local profile (provider's `isLocalProvider` is `false` —
Gemini, OpenAI, etc) requires `confirmPaid: true`. Without it the app returns `paid_requires_confirm`
and refuses to switch. **Pass `confirmPaid: true` ONLY when the user has explicitly asked to use a
paid model in the current request** (e.g. "test on Gemini", "switch to cloud model"). A generic
"switch profile" without naming the model is NOT consent.

### Switch the file-agent LLM profile (separate from chat-side)

The file-agent (sidebar Q&A panel, file-viewer edit panel, headless `agent_ask`) has its own LLM
profile axis, independent of the chat-side `llm_switch`. Use this when A/B-testing how a small vs
large model performs as file-agent without affecting the in-game story generator.

```
mcp__dev-bridge__file_agent_active {}                              # same meta shape as llm_active
mcp__dev-bridge__file_agent_switch { "id": "<local-profile-id>" }
mcp__dev-bridge__file_agent_switch { "id": "<gemini-profile-id>", "confirmPaid": true }
```

Same paid-guard rules as the chat-side switcher (`confirmPaid: true` only on explicit user consent).
The shared profile pool is listed by `llm_list` — these tools just pick which one the file-agent's
`FileAgentSettingsStore` points at.

### Fork the active Book at a message + switch between Books

When you want to keep the current playthrough as a baseline and try the next turn differently —
instead of `delete` (destructive) — fork the Book at that message and keep going on the fork. The
original Book stays intact and is reachable via `book_switch`.

```
mcp__dev-bridge__book_active {}                                          # capture id BEFORE fork — fork switches active
mcp__dev-bridge__list { "limit": 1 }                                     # grab the message id to fork at
mcp__dev-bridge__book_fork { "messageId": "<id>", "newName": "experiment-A" }
# Active is now experiment-A; run your test.
mcp__dev-bridge__send { "userInput": "...", "intent": "action" }
# Compare against baseline by switching back.
mcp__dev-bridge__book_switch { "id": "<original-id>" }
```

Capture the source Book id **before** forking — `book_fork` auto-switches the active Book to the new
fork, so `book_active` afterwards returns the fork, not the source.

`book_list` lists persisted Books (id / name / messageCount / isActive) without loading any of them.
It pages: `limit` defaults to 50, `offset` skips from the start of the list; the response carries
`total` (full count) and the echoed `offset` so you can walk a large library. `book_active` returns
just the currently active Book's id + name + messageCount — cheaper than filtering the full list
when you only need the active id.

`book_fork` truncates inclusively (the target message stays in the new Book). KB files are
deep-copied; stats reset to zero so the two Books never collide on a shared server-side cache.
`newName` is optional — omit to default to `<source name> (fork)`.

`book_switch` is the playthrough-level analogue of `profile_switch` — it loads a different Book as
the active session. Don't call it mid-turn (`busy` error).

### Repair a Book's KB (recover scenario files that never loaded)

When a Book was created from a scenario whose `scenarios.json` had stale filenames (e.g. JSON
pointed at `7.Magic.md` but the file on disk was `7.Magic_and_Skills.md`), the engine logs a
`console.error` and silently omits the file — the Book lives without it for its whole life. After
fixing `scenarios.json`, existing Books still miss the file.

`book_repair_kb` re-fetches every file declared in that scenario's manifest and **adds the ones the
active Book doesn't already have**. Existing KB entries are never overwritten (so player edits and
trigger-driven changes survive). The repaired KB is then persisted to the Book record so the
recovery survives a reload.

```
mcp__dev-bridge__kb_list {}                                          # before — see what's missing
mcp__dev-bridge__book_repair_kb { "scenarioId": "demo_world_en" }    # add missing files
mcp__dev-bridge__kb_list {}                                          # after — confirm
```

The response includes a per-file `updates[]` with status `added` / `skipped_existing` /
`fetch_failed`. The Book has no stored scenario id — you must supply the right one. It refuses
mid-turn (`busy`).

### Drive the in-app file-agent (handbook validation)

Once a Book is loaded, you can pop the in-app file-agent UI from outside so the agent picks up the
active KB and chat. Two surfaces, picked by editing need:

- `mcp__dev-bridge__agent_open_file_viewer` (optional `initialFile`) — opens the File Viewer dialog
  with the agent panel pre-opened. Full read+write surface, lands on `initialFile` (first KB file
  if omitted). Use this when you want the agent to actually edit a file or read it side-by-side.
- `mcp__dev-bridge__agent_open_chat_agent_panel` — pops the chat-side agent panel (read-only
  sidebar). Use this when interrogating the agent about mechanics or routing without editing —
  write tools are rejected here, which is exactly what you want for "is the handbook correct?"
  smoke testing.

```
mcp__dev-bridge__agent_open_chat_agent_panel {}
mcp__dev-bridge__agent_open_file_viewer { "initialFile": "3.Character_Status.md" }
```

Both return an ack frame; the user still types the actual question into the panel that appears.

When you want to push the question yourself so the user can just **watch** the panel react (instead
of copy-pasting from your message), `mcp__dev-bridge__agent_fill_chat_panel_prompt` auto-opens the
panel, lands the prompt in the input box, and with `autoSend: true` immediately fires `runAgent` so
the response streams live:

```
mcp__dev-bridge__agent_fill_chat_panel_prompt { "prompt": "book 列表怎麼看?", "autoSend": true }
```

Without `autoSend` the prompt sits in the input — useful when you want the user to read it before
sending. Distinct from `agent_ask` (next section), which runs a separate headless agent and returns
the log without touching the UI.

### Drive the in-app file-agent headlessly (autonomous handbook validation)

When you want to interrogate the in-app agent without the user typing into a UI panel, `agent_ask`
runs a dedicated headless FileAgentService turn against the active Book's KB + chat snapshot.

```
mcp__dev-bridge__agent_ask { "prompt": "book 跟 scenario 差別?", "clearHistory": true }
```

The response carries `finalResponse` (the agent's final submitResponse text), `replacements[]`
(files the agent tried to write, snapshot only), and `logCount` (how many log entries this turn
produced). The full per-entry log is **not** inlined — drill into it with two tools:

```
mcp__dev-bridge__agent_log_outline {}                 # index + role + type + toolName + reason, no bodies
mcp__dev-bridge__agent_log_read { "index": 2 }        # ONE entry's full body by index
```

`agent_log_outline` returns `entries[]` ({ `index`, `role`, `type`, optional `toolName` / `reason` })
for the MOST RECENT `agent_ask` turn — a cheap map of what happened. `agent_log_read` returns one
entry in full: `text`, optional `thought`, `entryType` (the entry's own kind — the envelope `type`
is the response discriminator), `toolName`, `reason`, `isToolCall`, `isToolResult`.

Both read a server-side cache of the last turn's log window, valid until the NEXT `agent_ask` (or a
`clearHistory: true`) shifts it — so outline/read drill into the turn you just ran, not an older one.
`no_agent_turn` comes back if no `agent_ask` has run yet; `index_out_of_range` for a bad index.

Modes (`mode`):
- `sidebar` (default) — `readOnly: true`. Write tools are rejected by the executor, matching the
  chat-side agent panel. Best for handbook Q&A validation (where the answer matters, not whether
  files change).
- `fileViewer` — `readOnly: false`. Write tools succeed against an **isolated snapshot Map**; the
  engine's `state.loadedFiles` is NEVER mutated. `replacements[]` shows what the agent would have
  written. Safe to use on an active playthrough.

**History defaults to PRESERVE (`clearHistory: false`).** The bridge service holds a singleton
file-agent, so each `agent_ask` sees the prior turn's `agentHistory` — useful for follow-up
questions but a leak hazard for fresh A/B comparisons. **Pass `clearHistory: true` on every NEW
question that should not see the previous tool calls / results in context** — unless it's a direct
follow-up to the immediately prior `agent_ask`. Leaking the prior turn's tool calls contaminates
A/B and token measurements. Concurrent `agent_ask` calls return `agent_busy`.

### Two-call timing

A single resolver+narrator turn on a slow local model can take 3-5 min and should not need polling.
Do NOT write retry loops around `send` to poll through busy state — every retry queues another turn
the app dutifully processes.

## Failure modes

| Symptom | Cause | What to do |
|---------|-------|------------|
| `app_not_connected` (503-equivalent) | Relay running but app WS not attached | Pause and tell the user to open the app + flip Debug Bridge toggle on; don't retry blindly |
| `app_timeout` | Generation > 600 s | Probably stuck or huge KB — tell user to abort in app, `list` to see what landed |
| `app_error` with `detail: "busy"` | App is mid-turn from another source | Wait passively; do NOT retry-loop, every retry queues another turn |
| `app_error` with `detail: "no_pair_produced"` | Engine returned without producing a model message (e.g. empty userInput on ACTION intent) | Check `userInput` — engine ignores empty strings on ACTION/FAST_FORWARD/SYSTEM |
| `client_id_required` | Multiple apps connected, no `clientId` given | Read the returned list, re-call with the right `clientId` |
| `client_not_connected` | Targeted `clientId` isn't attached | `clients` to see who's actually connected |
| `book_fork` returns `no_active_book` | App has no Book loaded (fresh install / book deleted) | Tell user to load or create a Book first |
| `book_fork` returns `message_not_found` | Target id not in active Book's history | `list` to re-verify the id; the user may have edited history under you |
| `book_switch` returns `unknown_book` | Book id doesn't exist in IDB | `book_list` to see actual ids — the user may have deleted it |
| `agent_open_file_viewer` returns `already_open` | A FileViewer dialog is already open in the app | Tell the user to close the existing one first; don't stack instances (Monaco mis-mounts the second one and shows blank) |
| `agent_open_file_viewer` returns `no_loaded_files` | No active Book or its KB is empty | Load a Book first via `book_switch` or have the user open one |
| `agent_ask` returns `agent_busy` | A previous `agent_ask` is still running | Wait for the prior call to resolve; do not retry-loop |
| `agent_ask` returns `agent_failed` | The headless agent threw (no LLM profile, stream error, etc.) | Check `detail` — usually "No LLM profile selected" or a provider error |
| `profile_set_prompt` returns `builtin_profile` | Active profile is a built-in (`cloud` / `local`) | Clone via Profile Management to a user-defined profile, switch active to the clone, retry |
| `profile_get_prompt` / `profile_set_prompt` returns `invalid_type` | `promptType` not a valid key | Typo — call `profile_get_all_prompts` to see the authoritative key list and check spelling |
| `read_message` returns `not_found` | The id isn't in the active Book's history | `list` to re-grab a current digest id; history may have shifted |
| `kb_grep` returns `invalid_pattern` | `pattern` is empty or not a valid JS regex | Fix the regex (it's `new RegExp(pattern)`, no flags) |
| `agent_log_outline` / `agent_log_read` returns `no_agent_turn` | No `agent_ask` has run this session (or the window was wiped) | Run `agent_ask` first; the drill-down tools read its cached log window |
| `agent_log_read` returns `index_out_of_range` | `index` is outside the last turn's log | Call `agent_log_outline` to see the valid index range (indices `0..logCount-1`, where `logCount` comes from `agent_ask`) |

## Don't

- Don't send non-`action` intents through `send` without checking — `system` / `fast_forward` run
  the real engine path; only fire them when the user asks for it.
- Don't delete messages without verifying via `list` first if the id wasn't from your most-recent
  `send` response (history can shift between sessions if the user did things in the UI).
- Don't run any of these tools without confirming the user's status indicator is green — blocking
  on a long-poll for a disconnected app burns time for nothing.
- Don't retry-loop on `busy` / `app_timeout` / `agent_busy` — passive wait only; each retry queues
  another turn.
