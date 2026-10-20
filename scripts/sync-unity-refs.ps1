[CmdletBinding()]
param([Parameter(Mandatory)][string]$DspDir)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$deckRoot = Split-Path -Parent $PSScriptRoot
$deckDestination = Join-Path $deckRoot '.local/game-refs'
$deckInstallation = [IO.Path]::GetFullPath($DspDir)
if (-not (Test-Path -LiteralPath (Join-Path $deckInstallation 'DSPGAME.exe'))) { throw 'The explicit DSP installation is invalid.' }
$deckReferences = @{
    'BepInEx.dll' = Join-Path $deckInstallation 'BepInEx/core/BepInEx.dll'
    'UnityEngine.dll' = Join-Path $deckInstallation 'DSPGAME_Data/Managed/UnityEngine.dll'
    'UnityEngine.CoreModule.dll' = Join-Path $deckInstallation 'DSPGAME_Data/Managed/UnityEngine.CoreModule.dll'
}
foreach ($deckPath in $deckReferences.Values) { if (-not (Test-Path -LiteralPath $deckPath)) { throw 'Required private reference is missing.' } }
New-Item -ItemType Directory -Path $deckDestination -Force | Out-Null
foreach ($deckEntry in $deckReferences.GetEnumerator()) {
    $deckOutput = Join-Path $deckDestination $deckEntry.Key
    Copy-Item -LiteralPath $deckEntry.Value -Destination $deckOutput
    [pscustomobject]@{ file = $deckEntry.Key; sha256 = (Get-FileHash -LiteralPath $deckOutput -Algorithm SHA256).Hash }
}
