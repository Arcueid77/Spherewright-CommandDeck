param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')]
    [string]$TestIdentity
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$registrationPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\SWCD.Test.' + $TestIdentity + '_is1'
$registrationResults = @()
try {
    foreach ($registrationHive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        $registrationBase = $null
        $registrationKey = $null
        try {
            $registrationBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey($registrationHive, [Microsoft.Win32.RegistryView]::Registry64)
            $registrationKey = $registrationBase.OpenSubKey($registrationPath, $false)
            $registrationRow = [ordered]@{ hive = $registrationHive.ToString(); present = ($null -ne $registrationKey) }
            if ($null -ne $registrationKey) {
                foreach ($registrationName in @('InstallLocation', 'DisplayVersion', 'DisplayIcon')) {
                    $registrationRow[$registrationName] = $registrationKey.GetValue($registrationName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                }
            }
            $registrationResults += [pscustomobject]$registrationRow
        } finally {
            if ($null -ne $registrationKey) { $registrationKey.Dispose() }
            if ($null -ne $registrationBase) { $registrationBase.Dispose() }
        }
    }
    [pscustomobject]@{ version = 1; registrations = $registrationResults } | ConvertTo-Json -Depth 4 -Compress
} catch {
    [Console]::Error.WriteLine('INSTALLER_REGISTRATION_READ_FAILED')
    exit 1
}
