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
    param([int] $Limit = 50)
    (Invoke-Bridge -Path '/list' -Body @{ limit = $Limit } -TimeoutSec 30).messages
}

function Remove-BridgeMessage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $MessageId,
        [bool] $AlsoDeletePair = $true
    )
    Invoke-Bridge -Path '/delete' -Body @{ messageId = $MessageId; alsoDeletePair = $AlsoDeletePair } -TimeoutSec 30
}
