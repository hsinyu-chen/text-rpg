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
        [int] $TimeoutSec = 130
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
