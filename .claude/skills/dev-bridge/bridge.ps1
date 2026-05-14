# PowerShell helpers for the TextRPG dev bridge.
#
# Dot-source before use:
#   . h:/MyWork/TextRPG/.claude/skills/dev-bridge/bridge.ps1
#
# All helpers send the body as UTF-8 bytes with an explicit charset header
# so non-ASCII userInput (e.g. CJK) round-trips correctly. See SKILL.md.

$script:BridgeBaseUrl = 'http://127.0.0.1:5051'
# Default clientId for all helpers in this session. Empty string means
# "auto-route" — bridge will pick the sole connected client, or 400 with
# `client_id_required` if multiple are connected. Override per-call via
# Invoke-Bridge -ClientId, or persistently with Use-BridgeClient.
$script:BridgeClientId = if ($env:TEXTRPG_BRIDGE_CLIENT_ID) { $env:TEXTRPG_BRIDGE_CLIENT_ID } else { '' }

function Use-BridgeClient {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Id)
    $script:BridgeClientId = $Id
}

function Get-BridgeClient {
    [CmdletBinding()] param()
    $script:BridgeClientId
}

function Get-BridgeClients {
    [CmdletBinding()] param()
    (Invoke-RestMethod -Uri "$script:BridgeBaseUrl/clients" -Method Get -TimeoutSec 10).clients
}

function Invoke-Bridge {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [hashtable] $Body,
        # Default raised to 600s (10 min) so two-call mode (resolver + narrator
        # = 2 LLM calls) doesn't time out at the HTTP layer on slow local
        # models. The bridge's own RequestTimeout matches.
        [int] $TimeoutSec = 600,
        # Override the script-default clientId for this single call. Pass an
        # explicit empty string to force auto-route.
        [AllowEmptyString()] [string] $ClientId
    )
    $effectiveId = if ($PSBoundParameters.ContainsKey('ClientId')) { $ClientId } else { $script:BridgeClientId }
    if (-not [string]::IsNullOrEmpty($effectiveId)) {
        $Body = $Body.Clone()
        $Body.clientId = $effectiveId
    }
    $json = $Body | ConvertTo-Json -Compress -Depth 8
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri "$script:BridgeBaseUrl$Path" -Method Post `
        -ContentType 'application/json; charset=utf-8' `
        -Body $bytes -TimeoutSec $TimeoutSec
}

function Send-BridgeAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $UserInput,
        [ValidateSet('action', 'continue', 'fast_forward', 'system', 'save')]
        [string] $Intent = 'action'
    )
    Invoke-Bridge -Path '/send' -Body @{ userInput = $UserInput; intent = $Intent }
}

function Get-BridgeMessages {
    [CmdletBinding()]
    param(
        [int] $Limit = 50,
        # Returns full message fields (analysis/summary/content/*_log) instead of
        # the default 80-char headPreview. Use when comparing turn output structure.
        [switch] $Full
    )
    $body = @{ limit = $Limit }
    if ($Full) { $body.full = $true }
    (Invoke-Bridge -Path '/list' -Body $body -TimeoutSec 30).messages
}

function Remove-BridgeMessage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $MessageId,
        [bool] $AlsoDeletePair = $true
    )
    Invoke-Bridge -Path '/delete' -Body @{ messageId = $MessageId; alsoDeletePair = $AlsoDeletePair } -TimeoutSec 30
}

function Invoke-BridgeReload {
    [CmdletBinding()]
    param(
        # window.location.reload(force) is non-standard / mostly ignored, but the
        # flag is plumbed through for explicit intent. Default: normal reload.
        [switch] $Force
    )
    $body = @{}
    if ($Force) { $body.force = $true }
    Invoke-Bridge -Path '/reload' -Body $body -TimeoutSec 30
}

function Get-BridgeProfile {
    [CmdletBinding()]
    param()
    Invoke-Bridge -Path '/profile/active' -Body @{} -TimeoutSec 30
}

function Get-BridgeProfiles {
    [CmdletBinding()]
    param()
    Invoke-Bridge -Path '/profile/list' -Body @{} -TimeoutSec 30
}

function Set-BridgeProfile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Id
    )
    Invoke-Bridge -Path '/profile/switch' -Body @{ id = $Id } -TimeoutSec 30
}

# Disk sync — for active user-defined prompt profile only.
#
# Pull reads the bound FSA folder back into IDB and runs forceReload(),
# so the next turn picks up the edits without an app reload. Push writes
# IDB out to disk. Both require: (a) active profile is user-defined
# (not built-in cloud/local) and (b) folder is already bound via the
# Profile Management dialog. Both refuse mid-turn with `busy`.
#
# Errors returned:
#   busy             — engine is processing a turn
#   builtin_profile  — active is a built-in profile (no disk row to mirror)
#   unknown_profile  — active id isn't in the registry
#   folder_not_found — (pull) profile folder doesn't exist on disk — push first
#   fsa_permission   — user revoked / cancelled the FSA prompt
#   disk_sync_failed — anything else (full message in `detail`)

function Invoke-BridgeProfilePull {
    [CmdletBinding()]
    param()
    # forceReload at the end is sync; total wall-time is one folder walk +
    # a handful of IDB writes — usually well under 5s.
    Invoke-Bridge -Path '/profile/pull-from-disk' -Body @{} -TimeoutSec 60
}

function Invoke-BridgeProfilePush {
    [CmdletBinding()]
    param()
    Invoke-Bridge -Path '/profile/push-to-disk' -Body @{} -TimeoutSec 60
}

# Direct prompt-row read/write on a profile's IDB store. The canonical
# AI A/B-tuning surface — bypasses the FSA disk-sync path entirely (no
# permission dialogs, no per-session manual seed). `Set` mutates the
# ACTIVE profile only, must be user-defined (built-ins are read-only
# via this path); routes through InjectionService.saveToService which
# refreshes the signal content + updates the prompt_user_modified KV
# flag, so the next turn sees the edit without a full reload. `Get`
# reads any profile by id (defaults to active); `content` is the
# resolved text (custom IDB row → shipped base via seed chain) and
# `hasOverride` indicates whether the profile has its own IDB row.

$script:BridgePromptTypes = @(
    'action', 'continue', 'fastforward', 'system', 'save',
    'postprocess', 'system_main', 'protocol_single',
    'protocol_resolver', 'protocol_narrator', 'correction'
)

function Get-BridgeProfilePrompt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('action', 'continue', 'fastforward', 'system', 'save',
                     'postprocess', 'system_main', 'protocol_single',
                     'protocol_resolver', 'protocol_narrator', 'correction')]
        [string] $Type,
        # Defaults to the active profile when omitted.
        [string] $ProfileId
    )
    $body = @{ type = $Type }
    if ($PSBoundParameters.ContainsKey('ProfileId')) { $body.profileId = $ProfileId }
    Invoke-Bridge -Path '/profile/get-prompt' -Body $body -TimeoutSec 30
}

function Get-BridgeProfilePrompts {
    [CmdletBinding()]
    param([string] $ProfileId)
    $body = @{}
    if ($PSBoundParameters.ContainsKey('ProfileId')) { $body.profileId = $ProfileId }
    Invoke-Bridge -Path '/profile/get-all-prompts' -Body $body -TimeoutSec 30
}

function Set-BridgeProfilePrompt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('action', 'continue', 'fastforward', 'system', 'save',
                     'postprocess', 'system_main', 'protocol_single',
                     'protocol_resolver', 'protocol_narrator', 'correction')]
        [string] $Type,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Content
    )
    Invoke-Bridge -Path '/profile/set-prompt' -Body @{ type = $Type; content = $Content } -TimeoutSec 30
}

function Get-BridgeKBFiles {
    [CmdletBinding()]
    param()
    (Invoke-Bridge -Path '/kb/list' -Body @{} -TimeoutSec 30).files
}

function Get-BridgeKBFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Filename,
        # Default returns the file content string; -Raw returns the full
        # response object (filename / content / tokenCount).
        [switch] $Raw
    )
    $resp = Invoke-Bridge -Path '/kb/read' -Body @{ filename = $Filename } -TimeoutSec 30
    if ($Raw) { $resp } else { $resp.content }
}

function Get-BridgeConfig {
    [CmdletBinding()]
    param()
    Invoke-Bridge -Path '/config/get' -Body @{} -TimeoutSec 30
}

function Get-BridgeBooks {
    [CmdletBinding()]
    param()
    (Invoke-Bridge -Path '/book/list' -Body @{} -TimeoutSec 30).books
}

function Get-BridgeBook {
    [CmdletBinding()]
    param()
    Invoke-Bridge -Path '/book/active' -Body @{} -TimeoutSec 30
}

function Invoke-BridgeBookFork {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $MessageId,
        [string] $NewName
    )
    $body = @{ messageId = $MessageId }
    if ($PSBoundParameters.ContainsKey('NewName')) { $body.newName = $NewName }
    # forkBookFromMessage flushes the source, writes a new Book, then loadBook()s
    # it — usually < 2s, but a large saved book + cold IDB can stretch.
    Invoke-Bridge -Path '/book/fork' -Body $body -TimeoutSec 60
}

function Set-BridgeBook {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Id)
    Invoke-Bridge -Path '/book/switch' -Body @{ id = $Id } -TimeoutSec 60
}

function Invoke-BridgeBookRepairKb {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $ScenarioId)
    Invoke-Bridge -Path '/book/repair-kb' -Body @{ scenarioId = $ScenarioId } -TimeoutSec 60
}

# File-agent UI surface openers — pop the in-app file-agent dialog (full read+
# write, KB editor) or the chat-side agent panel (read-only sidebar) so an
# outside agent can interrogate the in-game file-agent (handbook validation).
function Open-BridgeFileViewer {
    [CmdletBinding()]
    param([string] $InitialFile)
    $body = @{}
    if ($PSBoundParameters.ContainsKey('InitialFile')) { $body.initialFile = $InitialFile }
    Invoke-Bridge -Path '/agent/open-file-viewer' -Body $body -TimeoutSec 30
}

function Open-BridgeChatAgentPanel {
    Invoke-Bridge -Path '/agent/open-chat-agent-panel' -Body @{} -TimeoutSec 30
}

# Snapshot of which agent-hint manifest paths are currently mounted (directive
# attached) vs. unmounted (parent dialog / panel not yet opened). Quick way to
# verify a template wiring change without booting the UI manually — if a path
# you JUST added still shows up in .unmounted while the surrounding region is
# on-screen, the directive didn't mount (component import missed, etc).
function Get-BridgeAgentHints {
    Invoke-Bridge -Path '/agent/get-hints' -Body @{} -TimeoutSec 30
}

# Headless click of an `app://hint/<path>` link. Same effect as the user
# clicking the link inside the agent console — flashes / focuses / activates
# when the element is visible, otherwise the in-app snackbar shows a
# "Find it here → Sidebar > Settings > Font size" breadcrumb. Response tells
# you which path it took:
#   ok=true   → element was visible, action ran
#   ok=false, reason=unreachable, breadcrumb=...  → toast shown
#   ok=false, reason=unknown   → path not in manifest
# Use to test the deep-link wiring without typing into the console.
function Invoke-BridgeHint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [ValidateSet('highlight', 'focus', 'activate')] [string] $Action = 'highlight'
    )
    Invoke-Bridge -Path '/agent/trigger-hint' -Body @{ path = $Path; action = $Action } -TimeoutSec 30
}

# Returns getBoundingClientRect() for the path's mounted element + viewport
# size. mounted=false ≠ authoring bug — many entries only mount when their
# parent dialog opens; the caller decides whether that's expected here.
# Use after Invoke-BridgeHint to verify the element shifted into view, or
# pair with manual navigation to test that a directive landed on the right
# DOM node.
function Get-BridgeHintBBox {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    Invoke-Bridge -Path '/agent/get-hint-bbox' -Body @{ path = $Path } -TimeoutSec 30
}

# Dev-only async JS eval inside the running app. Body is compiled as an
# AsyncFunction — `await` works inside multi-statement blocks. Bare
# expressions auto-wrap as `return (expr)`. DOM nodes come back as
# { tag, id, classes } stubs; functions stringify; unawaited Promises in
# the result are flagged ("use return await ...").
#   Invoke-BridgeEval 'getComputedStyle(document.querySelector(".agent-sidebar")).zIndex'
#   Invoke-BridgeEval 'const r = await fetch("/assets/version.json"); return r.status'
function Invoke-BridgeEval {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Expr)
    Invoke-Bridge -Path '/agent/eval' -Body @{ expr = $Expr } -TimeoutSec 30
}

# Push a prompt into the VISIBLE chat-side agent panel input box (opens
# the panel first if it's closed). With -AutoSend the panel also fires
# runAgent immediately, so the human sees the agent stream live. Distinct
# from Send-BridgeAgentAsk, which runs a separate headless agent and
# returns the full log to PS; use this helper when you want the user to
# watch the actual panel react.
function Send-BridgeChatPanelPrompt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Prompt,
        [switch] $AutoSend
    )
    $body = @{
        prompt   = $Prompt
        autoSend = [bool]$AutoSend
    }
    Invoke-Bridge -Path '/agent/fill-chat-panel-prompt' -Body $body -TimeoutSec 30
}

# Send a prompt to a headless in-app file-agent and wait for the full log.
# Defaults to sidebar mode (readOnly) — write tools are rejected, matching
# the chat-side agent surface. -Mode fileViewer lets the agent call write
# tools, but the writes hit an isolated snapshot Map; the engine's KB
# stays untouched. -KeepHistory preserves prior turns instead of clearing.
function Send-BridgeAgentAsk {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Prompt,
        [ValidateSet('sidebar', 'fileViewer')] [string] $Mode = 'sidebar',
        [switch] $KeepHistory
    )
    $body = @{
        prompt = $Prompt
        mode   = $Mode
    }
    if ($KeepHistory) { $body.clearHistory = $false }
    Invoke-Bridge -Path '/agent/ask' -Body $body -TimeoutSec 600
}

# LLM profile selectors (model/API endpoint — distinct from prompt profile).
# Set-BridgeLLMProfile REQUIRES -ConfirmPaid when the target profile is not
# local; this is the agent-side gate that complements the app's confirmPaid
# guard. Don't bypass it from helpers.

function Get-BridgeLLMProfiles {
    (Invoke-Bridge -Path '/llm/list' -Body @{} -TimeoutSec 30).profiles
}

function Get-BridgeLLMProfile {
    Invoke-Bridge -Path '/llm/active' -Body @{} -TimeoutSec 30
}

function Set-BridgeLLMProfile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Id,
        [switch] $ConfirmPaid
    )
    $body = @{ id = $Id }
    if ($ConfirmPaid) { $body.confirmPaid = $true }
    Invoke-Bridge -Path '/llm/switch' -Body $body -TimeoutSec 30
}

# File-agent LLM profile selectors. Independent of the chat-side profile —
# lets you A/B-test a small vs large model on the in-app file-agent (sidebar
# Q&A / file-viewer edit panel / agent_ask) while chat keeps running on a
# different model. Paid-model guard is the same: switching to a non-local
# profile requires -ConfirmPaid.

function Get-BridgeFileAgentProfile {
    Invoke-Bridge -Path '/file-agent/active' -Body @{} -TimeoutSec 30
}

function Set-BridgeFileAgentProfile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Id,
        [switch] $ConfirmPaid
    )
    $body = @{ id = $Id }
    if ($ConfirmPaid) { $body.confirmPaid = $true }
    Invoke-Bridge -Path '/file-agent/switch' -Body $body -TimeoutSec 30
}

function Set-BridgeConfig {
    [CmdletBinding()]
    param(
        [ValidateSet('single', 'two-call')] [string] $EngineMode,
        [string] $OutputLanguage,
        [int] $FontSize,
        [string] $FontFamily,
        [ValidateSet('invaders', 'code')] [string] $ScreensaverType,
        [string] $Currency,
        [bool] $EnableConversion,
        [bool] $IdleOnBlur,
        [bool] $EnableAdultDeclaration,
        [double] $ExchangeRate,
        [string] $InterfaceLanguage,
        [int] $SmartContextTurns
    )
    $body = @{}
    if ($PSBoundParameters.ContainsKey('EngineMode'))             { $body.engineMode             = $EngineMode }
    if ($PSBoundParameters.ContainsKey('OutputLanguage'))         { $body.outputLanguage         = $OutputLanguage }
    if ($PSBoundParameters.ContainsKey('FontSize'))               { $body.fontSize               = $FontSize }
    if ($PSBoundParameters.ContainsKey('FontFamily'))             { $body.fontFamily             = $FontFamily }
    if ($PSBoundParameters.ContainsKey('ScreensaverType'))        { $body.screensaverType        = $ScreensaverType }
    if ($PSBoundParameters.ContainsKey('Currency'))               { $body.currency               = $Currency }
    if ($PSBoundParameters.ContainsKey('EnableConversion'))       { $body.enableConversion       = $EnableConversion }
    if ($PSBoundParameters.ContainsKey('IdleOnBlur'))             { $body.idleOnBlur             = $IdleOnBlur }
    if ($PSBoundParameters.ContainsKey('EnableAdultDeclaration')) { $body.enableAdultDeclaration = $EnableAdultDeclaration }
    if ($PSBoundParameters.ContainsKey('ExchangeRate'))           { $body.exchangeRate           = $ExchangeRate }
    if ($PSBoundParameters.ContainsKey('InterfaceLanguage'))      { $body.interfaceLanguage      = $InterfaceLanguage }
    if ($PSBoundParameters.ContainsKey('SmartContextTurns'))      { $body.smartContextTurns      = $SmartContextTurns }
    Invoke-Bridge -Path '/config/set' -Body $body -TimeoutSec 30
}
