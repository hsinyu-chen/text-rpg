# PowerShell helpers for the TextRPG dev bridge.
#
# Dot-source before use:
#   . h:/MyWork/TextRPG/.claude/skills/dev-bridge/bridge.ps1
#
# All helpers send the body as UTF-8 bytes with an explicit charset header
# so non-ASCII userInput (e.g. CJK) round-trips correctly. See SKILL.md.

$script:BridgeBaseUrl = 'http://127.0.0.1:5051'

function Invoke-Bridge {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [hashtable] $Body,
        # Default raised to 600s (10 min) so two-call mode (resolver + narrator
        # = 2 LLM calls) doesn't time out at the HTTP layer on slow local
        # models. The bridge's own RequestTimeout matches.
        [int] $TimeoutSec = 600
    )
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
