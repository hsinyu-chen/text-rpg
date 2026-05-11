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

function Get-BridgeConfig {
    [CmdletBinding()]
    param()
    Invoke-Bridge -Path '/config/get' -Body @{} -TimeoutSec 30
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
