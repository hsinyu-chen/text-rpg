---
name: dev-bridge
description: Drive a running TextRPG dev build through the local BridgeServer relay. Use when the user wants to test prompts/engine changes by sending actions, listing chat state, or deleting+retrying a turn — anything like "send a turn via the bridge", "drive the app", "test through the relay", "delete that pair and retry". Skip for in-app UI testing or any change unrelated to live LLM turns.
---

# dev-bridge — drive TextRPG via the local relay

The user's setup runs three pieces:

1. TextRPG dev server at `https://localhost:4200` (`npm start` in [h:/MyWork/TextRPG](h:/MyWork/TextRPG))
2. BridgeServer at `http://127.0.0.1:5051` (agent) + `wss://127.0.0.1:5050/app` (app)
   ([h:/MyWork/TextRPG_TestBridge](h:/MyWork/TextRPG_TestBridge), `dotnet run`)
3. The app's Settings → Debug Bridge has the URL set + toggle on, and the status indicator is **green**.

When all three are up, you drive the app via HTTP from PowerShell.

## Critical: Windows + UTF-8

**Do not use `curl -d` from Bash on Windows for non-ASCII bodies.** Windows console encodes
literal CJK characters as the active codepage (CP950/CP936) before curl sees them, the server
parses as UTF-8, and you get `���` in chat history. Symptom: the UI shows replacement chars
even though your terminal looked fine.

Always send through PowerShell with explicit UTF-8 encoding, via the helper at
[bridge.ps1](bridge.ps1):

```pwsh
. h:/MyWork/TextRPG/.claude/skills/dev-bridge/bridge.ps1
```

Then call the helpers below. The PowerShell tool resets shell state between calls, so dot-source
on every invocation.

## Common workflows

### Sanity check what's loaded

```pwsh
. h:/MyWork/TextRPG/.claude/skills/dev-bridge/bridge.ps1; Get-BridgeMessages -Limit 5 | Format-Table id, role, headPreview
```

If you see `app_not_connected`, the user's app isn't connected — pause and tell them to flip the
Debug Bridge toggle / open the app, do not retry blindly.

### Drive one action turn

Action format inside `userInput` is `([心境]動作)台詞` — emotion in brackets, then the physical
action, then the spoken line. The engine prepends the `<行動意圖>` tag itself, so do not include
it.

```pwsh
. h:/MyWork/TextRPG/.claude/skills/dev-bridge/bridge.ps1
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
. h:/MyWork/TextRPG/.claude/skills/dev-bridge/bridge.ps1
Remove-BridgeMessage -MessageId $resp.messageId   # nukes the pair
Send-BridgeAction -UserInput "([緊張]說)等一下，先別走" -Intent action
```

Pass `-AlsoDeletePair:$false` if you really want to remove only one side (rare).

## Failure modes

| Symptom | Cause | What to do |
|---------|-------|------------|
| `app_not_connected` (HTTP 503) | Bridge running but app WS not attached | Tell user to open app + flip Debug Bridge toggle on |
| `app_timeout` (504) | Generation > 120 s | Probably stuck or huge KB — tell user to abort in app, list to see what landed |
| `app_error` with `detail: "busy"` | App is mid-turn from another source | Wait and retry; if persistent, ask the user |
| `app_error` with `detail: "no_pair_produced"` | Engine returned without producing a model message (e.g. empty userInput on ACTION intent) | Check `userInput` — engine ignores empty strings on ACTION/FAST_FORWARD/SYSTEM |
| `���` in `pair.user.content` | UTF-8 encoding bug — you used `curl -d` instead of the PS helpers | Delete the pair, retry through `Send-BridgeAction` |

## Don't

- Don't bypass the helpers. Inline `curl` from Bash on Windows will silently mojibake non-ASCII.
- Don't send non-action intents through `Send-BridgeAction` without checking — `save` triggers
  the actual save flow with `<存檔>` and writes to the book; only do this when the user asks for it.
- Don't delete messages without verifying via `Get-BridgeMessages` first if the id wasn't from
  your most-recent `$resp` (history can shift between sessions if the user did things in the UI).
- Don't run any of these helpers without confirming the user's status indicator is green —
  blocking on a long-poll for a disconnected app burns 120 s for nothing.
