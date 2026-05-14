---
name: dev-bridge
description: Drive a running TextRPG dev build through the local BridgeServer relay. Use when the user wants to test prompts/engine changes by sending actions, listing chat state, or deleting+retrying a turn — anything like "send a turn via the bridge", "drive the app", "test through the relay", "delete that pair and retry". Skip for in-app UI testing or any change unrelated to live LLM turns.
---

# dev-bridge — drive TextRPG via the local relay

The user's setup runs three pieces:

1. TextRPG dev server at `https://localhost:4200` (`npm start` from the TextRPG repo)
2. BridgeServer at `http://127.0.0.1:5051` (agent) + `wss://127.0.0.1:5050/app` (app), from
   the sibling [text-rpg-test-bridge](https://github.com/hsinyu-chen/text-rpg-test-bridge) checkout
   (`dotnet run`)
3. The app's Settings → Debug Bridge has the URL set + toggle on, and the status indicator is **green**.

When all three are up, you drive the app via HTTP from PowerShell. The dot-source paths
below are relative to the TextRPG repo root, which is the harness's default working directory.

## Critical: Windows + UTF-8

**Do not use `curl -d` from Bash on Windows for non-ASCII bodies.** Windows console encodes
literal CJK characters as the active codepage (CP950/CP936) before curl sees them, the server
parses as UTF-8, and you get `���` in chat history. Symptom: the UI shows replacement chars
even though your terminal looked fine.

Always send through PowerShell with explicit UTF-8 encoding, via the helper at
[bridge.ps1](bridge.ps1):

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
```

Then call the helpers below. The PowerShell tool resets shell state between calls, so dot-source
on every invocation.

## Common workflows

### Sanity check what's loaded

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1; Get-BridgeMessages -Limit 5 | Format-Table id, role, headPreview
```

`Get-BridgeMessages` defaults to a `headPreview` (first 80 chars of `content`). When you need
to compare full turn output structure (e.g. baseline vs post-change verification), pass `-Full`:

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
$last = (Get-BridgeMessages -Limit 1 -Full)[0]
$last.analysis    # full analysis block (【現況盤點】/【動作N】/【全場景N】/【事件】 etc)
$last.summary     # [EVT] / [NPC] / [PLOT] telegraphic summary
$last.content     # the full scene incl. <CREATIVE FICTION CONTEXT> header
$last.character_log; $last.inventory_log; $last.world_log; $last.quest_log
```

If you see `app_not_connected`, the user's app isn't connected — pause and tell them to flip the
Debug Bridge toggle / open the app, do not retry blindly.

### Multi-client routing

BridgeServer accepts multiple connected app instances (e.g. desktop + laptop + Tauri build),
each identified by the `clientId` the app sends in its `hello` frame. The HTTP API routes a
call by reading `clientId` from the request body.

- `Get-BridgeClients` — list currently-connected clientIds
- `Use-BridgeClient -Id desktop` — set the session-wide default for subsequent helpers
- `Get-BridgeClient` — show the current default (empty = auto-route)
- `Invoke-Bridge -ClientId laptop ...` — one-shot override

Without an explicit clientId the bridge auto-routes when exactly one client is connected; with
multiple it returns `400 client_id_required` plus the list of available ids. If the targeted
client isn't connected you get `503 client_not_connected`.

You can also pre-set `$env:TEXTRPG_BRIDGE_CLIENT_ID` before dot-sourcing to fix the default at
shell-init time.

### Reload the running app

After editing prompt assets in `public/assets/system_files/**/*.md`, the running app still has
the old text in memory — those files are fetched once at init. Trigger a hard refresh from
the agent side:

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1; Invoke-BridgeReload | Out-Null
```

The app acks then reloads, so the WS drops mid-flight (expected). After ~2 s the WS reconnects
and `Get-BridgeMessages` works again. Use this any time you change `system_prompt.md` /
`injection_*.md` and want to verify behavior on the live app without asking the user to F5.

### Drive one action turn

Action format inside `userInput` is `([心境]動作)台詞` — emotion in brackets, then the physical
action, then the spoken line. The engine prepends the `<行動意圖>` tag itself, so do not include
it.

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
$resp = Send-BridgeAction -UserInput "([好奇]張望)這裡是哪？" -Intent action
$resp.pair.model.summary    # one-line story summary the engine produced
$resp.pair.model.content    # the full scene
$resp.messageId             # use this id if you need to delete/retry
```

Other intents: `continue` (just `<繼續>`, empty userInput is fine), `fast_forward`, `system`,
`save`. Pass `null` / omit to default to `action`.

### Delete a turn and retry

`alsoDeletePair` defaults to true — passing a model id removes it plus the user message right
before it (and vice versa). Use this whenever the model output isn't what you wanted and you
want to re-run with a tweaked prompt or different input.

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
Remove-BridgeMessage -MessageId $resp.messageId   # nukes the pair
Send-BridgeAction -UserInput "([緊張]說)等一下，先別走" -Intent action
```

Pass `-AlsoDeletePair:$false` if you really want to remove only one side (rare).

### Read the active book's KB files

When debugging save-XML output, prompt-grounding issues, or anything that
depends on what the engine currently sees as the world state, fetch the
loaded knowledge-base files directly. Same content the engine reads —
no IndexedDB / disk-sync detour.

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
Get-BridgeKBFiles | Format-Table filename, size, tokenCount
Get-BridgeKBFile -Filename '6.Factions_and_World.md'      # content string
Get-BridgeKBFile -Filename '2.Story_Outline.md' -Raw      # full response object
```

`Get-BridgeKBFiles` returns the in-memory `state.loadedFiles` map, so it
reflects edits made through the File Viewer / file-agent without a save.
`not_found` comes back if the filename doesn't match any loaded entry —
filenames are language-bucketed (`2.Story_Outline.md` vs `2.劇情綱要.md`)
so check the list first if you're unsure.

This endpoint is **read-only** — there is no `Set-BridgeKBFile` because
KB writes already have a richer in-app path (File Viewer Monaco editor,
`<Save>` auto-update flow, file-agent `searchReplace`). The bridge isn't
the right surface for blind in-place edits.

### Edit prompt rows directly via bridge (canonical AI A/B path)

The right primitive for AI-driven prompt-tuning A/B is direct IDB
read/write — no disk, no FSA, no permission dialogs, no per-session
manual seed. `Set-BridgeProfilePrompt` mutates the active profile's
IDB row via `InjectionService.saveToService`, which updates the
`prompt_user_modified` KV flag and refreshes the in-memory signal,
so the next turn picks up the edit without a heavy full reload.
`Get-BridgeProfilePrompt` reads any profile by id (defaults to
active) — useful for diffing user-defined against built-in.

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
$current = Get-BridgeProfilePrompt -Type system_main          # active profile
Set-BridgeProfilePrompt -Type system_main -Content $newText   # writes IDB + reloads engine
Send-BridgeAction -UserInput '...' -Intent action             # next turn uses the edit
```

Compare across profiles with an explicit id:
```pwsh
$base    = Get-BridgeProfilePrompt -Type system_main -ProfileId cloud
$mine    = Get-BridgeProfilePrompt -Type system_main           # active is the user-defined clone
diff $base.content $mine.content
```

`Get-BridgeProfilePrompts` returns all 11 rows in one call — useful
when greping across types.

Prompt types: `action` / `continue` / `fastforward` / `system` / `save`
/ `postprocess` / `system_main` / `protocol_single` / `protocol_resolver`
/ `protocol_narrator` / `correction`. `Set` validates via
PowerShell's `ValidateSet`, so typos fail before hitting the bridge.

**Set is restricted to the active profile and the profile must be
user-defined.** Built-in profiles (`cloud`/`local`) are read-only via
this path — clone via Profile Management and switch active to the clone
to tune. Set refuses mid-turn (`busy`); Get is always available.

**`content` is the resolved prompt** the engine actually renders for
that profile — custom IDB override is returned when present, otherwise
the shipped base asset is read on demand. So reading a built-in profile
returns its real text, not an empty string.

**`hasOverride` flag** distinguishes "this profile has its own IDB row
for this type" (true) from "this profile is reading the shipped base"
(false). Useful for confirming a `Set-BridgeProfilePrompt` actually
landed, and for diffing customized vs default state.

### Inspect / change profile + engine config

When verifying which prompt profile is active, switching profiles, or toggling
`engineMode` from outside the UI:

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
Get-BridgeProfile             # active profile id + displayName + compat
Get-BridgeProfiles            # full list (built-in + user) with compat tags
Set-BridgeProfile -Id cloud   # switch active

Get-BridgeConfig                            # full AppConfigShape snapshot + modelId
Set-BridgeConfig -EngineMode two-call       # toggle two-call mode
Set-BridgeConfig -OutputLanguage default    # partial patch — only listed params are sent
Set-BridgeConfig -FontSize 18 -FontFamily 'serif'   # any AppConfigShape field is settable
```

`Set-BridgeConfig` accepts every `AppConfigShape` field (engineMode, outputLanguage,
fontSize, fontFamily, screensaverType, currency, enableConversion, idleOnBlur,
enableAdultDeclaration, exchangeRate, interfaceLanguage, smartContextTurns). The
handler is a per-field validator: unknown keys or wrong types come back under
`rejected` in the response instead of being silently dropped. `apiKey` / `modelId`
/ thinking levels are NOT in scope — those live on the active LLM profile, not
on `AppConfigShape`.

`compat` is `'compatible'` when the profile's `system_main` carries the current
`@system-main-version` marker, `'legacy'` for pre-PR-#28 forks. Legacy profiles
auto-switch to default at turn time (with a snackbar) — driving turns on a
legacy profile via `Send-BridgeAction` will silently land on default.

### Switch the LLM profile (model + API endpoint)

Prompt profile (`Set-BridgeProfile`) selects which **prompts** the engine
uses; **LLM profile** selects which **model + API endpoint** it calls (local
llama.cpp vs Gemini / OpenAI / etc). These are separate axes — switch one
without the other when you want to isolate which variable matters.

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
Get-BridgeLLMProfile          # active LLM profile (id + name + provider + modelId + isLocal)
Get-BridgeLLMProfiles         # all LLM profiles with isLocal flag
Set-BridgeLLMProfile -Id <local-profile-id>                  # local → free, no guard
Set-BridgeLLMProfile -Id <gemini-profile-id> -ConfirmPaid    # paid → requires explicit flag
```

**Paid model guard**: switching to any profile where the provider's
`isLocalProvider` is `false` (Gemini, OpenAI, etc) requires `-ConfirmPaid` on
the PS helper AND `confirmPaid: true` in the underlying bridge body. Without
the flag the app returns `paid_requires_confirm` and refuses to switch — this
prevents accidentally driving turns through a paid model. **Do not pass
`-ConfirmPaid` unless the user has explicitly asked to use a paid model in
the current request** (e.g. "test on Gemini", "switch to cloud model"). A
generic "switch profile" without naming the model is NOT consent.

### Switch the file-agent LLM profile (separate from chat-side)

The file-agent (sidebar Q&A panel, file-viewer edit panel, headless
`agent_ask`) has its own LLM profile axis, independent of the chat-side
`Set-BridgeLLMProfile`. Use this when A/B-testing how a small vs large model
performs as file-agent without affecting the in-game story generator.

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
Get-BridgeFileAgentProfile             # active file-agent profile (same meta shape as Get-BridgeLLMProfile)
Set-BridgeFileAgentProfile -Id <local-profile-id>
Set-BridgeFileAgentProfile -Id <gemini-profile-id> -ConfirmPaid
```

Same paid-guard rules as the chat-side switcher. The shared profile pool is
listed by `Get-BridgeLLMProfiles` — these helpers just pick which one the
file-agent's `FileAgentSettingsStore` points at.

### Fork the active Book at a message + switch between Books

When you want to keep the current playthrough as a baseline and try the next
turn differently — instead of `Remove-BridgeMessage` (which is destructive),
fork the Book at that message and keep going on the fork. The original Book
stays intact and is reachable via `Set-BridgeBook`.

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
$original = Get-BridgeBook          # capture id BEFORE fork — fork switches active
$last = (Get-BridgeMessages -Limit 1)[0]
$fork = Invoke-BridgeBookFork -MessageId $last.id -NewName 'experiment-A'
# Active is now experiment-A; run your test.
Send-BridgeAction -UserInput '...' -Intent action
# Compare against baseline by switching back.
Set-BridgeBook -Id $original.id | Out-Null
```

`Get-BridgeBooks` lists every persisted Book (id / name / messageCount /
isActive) without loading any of them. `Get-BridgeBook` returns just the
currently active Book's id + name + messageCount — cheaper than filtering
the full list when you only need the active id.

`Invoke-BridgeBookFork` truncates inclusively (the target message stays in
the new Book). KB files are deep-copied; stats reset to zero so the two
Books never collide on a shared server-side cache. `-NewName` is optional —
omit to default to `<source name> (fork)`.

`Set-BridgeBook -Id <id>` is the playthrough-level analogue of
`Set-BridgeProfile` — it loads a different Book as the active session.
Don't call it mid-turn (`busy` error).

### Repair a Book's KB (recover scenario files that never loaded)

When a Book was created from a scenario whose `scenarios.json` had stale
filenames (e.g. JSON pointed at `7.Magic.md` but the file on disk was
`7.Magic_and_Skills.md`), the engine logs a `console.error` and silently
omits the file — the Book lives without it for its whole life. After
fixing `scenarios.json`, existing Books still miss the file.

`Invoke-BridgeBookRepairKb -ScenarioId <id>` re-fetches every file declared
in that scenario's manifest and **adds the ones the active Book doesn't
already have**. Existing KB entries are never overwritten (so player edits
and trigger-driven changes survive). The repaired KB is then persisted to
the Book record so the recovery survives a reload.

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
Get-BridgeKBFiles                                      # before — see what's missing
Invoke-BridgeBookRepairKb -ScenarioId demo_world_en    # add missing files
Get-BridgeKBFiles                                      # after — confirm
```

The response includes a per-file `updates[]` with status `added` /
`skipped_existing` / `fetch_failed`. Book has no stored scenario id —
caller must supply the right one.

### Drive the in-app file-agent (handbook validation)

Once a Book is loaded, you can pop the in-app file-agent UI from outside so
the agent picks up the active KB and chat. Two surfaces, picked by editing
need:

- `Open-BridgeFileViewer [-InitialFile <name>]` — opens the File Viewer
  dialog with the agent panel pre-opened. Full read+write surface, lands on
  `InitialFile` (first KB file if omitted). Use this when you want the
  agent to actually edit a file or read it side-by-side.
- `Open-BridgeChatAgentPanel` — pops the chat-side agent panel (read-only
  sidebar). Use this when interrogating the agent about mechanics or
  routing without editing — write tools are rejected here, which is exactly
  what you want for "is the handbook correct?" smoke testing.

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
Open-BridgeChatAgentPanel                       # pop sidebar agent
Open-BridgeFileViewer -InitialFile '3.Character_Status.md'
```

Both return an ack frame; the user still types the actual question into
the panel that appears.

When you want to push the question yourself so the user can just **watch**
the panel react (instead of copy-pasting from your message),
`Send-BridgeChatPanelPrompt` auto-opens the panel, lands the prompt in
the input box, and with `-AutoSend` immediately fires `runAgent` so the
response streams live:

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
Send-BridgeChatPanelPrompt -Prompt 'book 列表怎麼看?' -AutoSend
```

Without `-AutoSend` the prompt sits in the input — useful when you want
the user to read it first before sending. Distinct from
`Send-BridgeAgentAsk` (next section), which runs a separate headless
agent and returns the log to PS without touching the UI.

### Drive the in-app file-agent headlessly (autonomous handbook validation)

When you want to interrogate the in-app agent without the user typing into
a UI panel, `Send-BridgeAgentAsk` runs a dedicated headless FileAgentService
turn against the active Book's KB + chat snapshot and returns the full log
(thoughts, tool calls, tool results, final answer).

```pwsh
. ./.claude/skills/dev-bridge/bridge.ps1
$r = Send-BridgeAgentAsk -Prompt "book 跟 scenario 差別?"
$r.finalResponse              # the agent's final submitResponse text
$r.logs | Where-Object isToolCall | Select toolName, reason  # what tools fired
$r.replacements               # files the agent tried to write (snapshot only)
```

Modes:
- `-Mode sidebar` (default) — `readOnly: true`. Write tools are rejected
  by the executor, matching the chat-side agent panel. Best for handbook
  Q&A validation (where the answer matters, not whether files change).
- `-Mode fileViewer` — `readOnly: false`. Write tools succeed against an
  **isolated snapshot Map**; the engine's `state.loadedFiles` is NEVER
  mutated. `replacements[]` in the response shows what the agent would
  have written. Safe to use on an active playthrough.

`-KeepHistory` preserves the prior turn's `agentHistory` so you can run a
follow-up question; default behavior wipes history per call (each Q&A is
fresh). The agent instance is one-per-bridge — concurrent `agent_ask`
calls return `agent_busy`.

### Two-call timing

Bridge `RequestTimeout` is 600s and PS helper `Invoke-Bridge` defaults match —
single resolver+narrator turns on a slow local model can take 3-5 min and
should not need polling. Don't write `until` loops around `Send-BridgeAction`
to retry through busy state — every retry queues another turn the app dutifully
processes.

## Failure modes

| Symptom | Cause | What to do |
|---------|-------|------------|
| `app_not_connected` (HTTP 503) | Bridge running but app WS not attached | Tell user to open app + flip Debug Bridge toggle on |
| `app_timeout` (504) | Generation > 600 s | Probably stuck or huge KB — tell user to abort in app, list to see what landed |
| `app_error` with `detail: "busy"` | App is mid-turn from another source | Wait passively; do NOT retry-loop, every retry queues another turn |
| `app_error` with `detail: "no_pair_produced"` | Engine returned without producing a model message (e.g. empty userInput on ACTION intent) | Check `userInput` — engine ignores empty strings on ACTION/FAST_FORWARD/SYSTEM |
| `���` in `pair.user.content` | UTF-8 encoding bug — you used `curl -d` instead of the PS helpers | Delete the pair, retry through `Send-BridgeAction` |
| `book_fork` returns `no_active_book` | App has no Book loaded (fresh install / book deleted) | Tell user to load or create a Book first |
| `book_fork` returns `message_not_found` | Target id not in active Book's history | `Get-BridgeMessages` to re-verify the id; the user may have edited history under you |
| `book_switch` returns `unknown_book` | Book id doesn't exist in IDB | `Get-BridgeBooks` to see actual ids — the user may have deleted it |
| `agent_open_file_viewer` returns `already_open` | A FileViewer dialog is already open in the app | Tell the user to close the existing one first; don't stack instances (Monaco mis-mounts the second one and shows blank) |
| `agent_open_file_viewer` returns `no_loaded_files` | No active Book or its KB is empty | Load a Book first via `Set-BridgeBook` or have the user open one |
| `agent_ask` returns `agent_busy` | A previous `agent_ask` is still running | Wait for the prior call to resolve; do not retry-loop |
| `agent_ask` returns `agent_failed` | The headless agent threw (no LLM profile, stream error, etc.) | Check `detail` — usually "No LLM profile selected" or a provider error |
| `profile_set_prompt` returns `builtin_profile` | Active profile is a built-in (`cloud` / `local`) | Clone via Profile Management to a user-defined profile, switch active to the clone, retry |
| `profile_get_prompt` / `profile_set_prompt` returns `invalid_type` | `-Type` not in the 11-value set | Typo — the PS helper's ValidateSet should have caught it; check spelling |

## Don't

- Don't bypass the helpers. Inline `curl` from Bash on Windows will silently mojibake non-ASCII.
- Don't send non-action intents through `Send-BridgeAction` without checking — `save` triggers
  the actual save flow with `<存檔>` and writes to the book; only do this when the user asks for it.
- Don't delete messages without verifying via `Get-BridgeMessages` first if the id wasn't from
  your most-recent `$resp` (history can shift between sessions if the user did things in the UI).
- Don't run any of these helpers without confirming the user's status indicator is green —
  blocking on a long-poll for a disconnected app burns 120 s for nothing.
