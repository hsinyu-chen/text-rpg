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

## Don't

- Don't bypass the helpers. Inline `curl` from Bash on Windows will silently mojibake non-ASCII.
- Don't send non-action intents through `Send-BridgeAction` without checking — `save` triggers
  the actual save flow with `<存檔>` and writes to the book; only do this when the user asks for it.
- Don't delete messages without verifying via `Get-BridgeMessages` first if the id wasn't from
  your most-recent `$resp` (history can shift between sessions if the user did things in the UI).
- Don't run any of these helpers without confirming the user's status indicator is green —
  blocking on a long-poll for a disconnected app burns 120 s for nothing.
