param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][ValidateSet('inspect', 'deny', 'restore')][string]$Operation,
    [string]$OriginalDacl,
    [string]$DeniedDacl
)
$ErrorActionPreference = 'Stop'
$Step = 'scope'
try {
    $BaseInfo = Get-Item -LiteralPath $Root -Force
    $TargetInfo = Get-Item -LiteralPath $File -Force
    $TemporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not $BaseInfo.PSIsContainer -or $TargetInfo.PSIsContainer -or
        $BaseInfo.Parent.FullName -ine $TemporaryParent -or
        -not $BaseInfo.Name.StartsWith('commanddeck-desktop-smoke-') -or
        ($BaseInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($TargetInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        -not $TargetInfo.FullName.StartsWith($BaseInfo.FullName + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'scope' }
    $Relative = $TargetInfo.FullName.Substring($BaseInfo.FullName.Length + 1).Replace('\', '/')
    if ($Relative -notmatch '^supervisor-profile/supervisor/(?:game-smoke-[a-f0-9-]{36}/game-tasks|m1-smoke-[a-f0-9-]{36}/workbench)\.sqlite$' -or $TargetInfo.Length -gt 8388608) { throw 'scope' }
    $Step = 'descriptor-read'
    $Sections = [Security.AccessControl.AccessControlSections]::Access
    $Security = Get-Acl -LiteralPath $File
    $Current = $Security.GetSecurityDescriptorSddlForm($Sections)
    if ($Operation -eq 'inspect') {
        $Step = 'deny-rule'
        $Identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $Rule = [Security.AccessControl.FileSystemAccessRule]::new($Identity, [Security.AccessControl.FileSystemRights]::Write, [Security.AccessControl.AccessControlType]::Deny)
        $Security.AddAccessRule($Rule)
        $Planned = $Security.GetSecurityDescriptorSddlForm($Sections)
        if ($Current -ceq $Planned) { throw 'already-denied' }
        [pscustomobject]@{ version = 1; originalDacl = $Current; deniedDacl = $Planned } | ConvertTo-Json -Compress
        exit 0
    }
    if (-not $OriginalDacl.StartsWith('D:') -or -not $DeniedDacl.StartsWith('D:') -or
        $OriginalDacl.Length -gt 16384 -or $DeniedDacl.Length -gt 16384 -or $OriginalDacl -ceq $DeniedDacl) { throw 'descriptor' }
    if ($Operation -eq 'deny') {
        if ($Current -cne $OriginalDacl) { throw 'changed-before-deny' }
        $Desired = $DeniedDacl
    } else {
        if ($Current -ceq $OriginalDacl) {
            [pscustomobject]@{ version = 1; restored = $true; alreadyOriginal = $true } | ConvertTo-Json -Compress
            exit 0
        }
        if ($Current -cne $DeniedDacl) { throw 'unexpected-permissions' }
        $Desired = $OriginalDacl
    }
    $Step = 'descriptor-write'
    $Security.SetSecurityDescriptorSddlForm($Desired, $Sections)
    Set-Acl -LiteralPath $File -AclObject $Security
    $Actual = (Get-Acl -LiteralPath $File).GetSecurityDescriptorSddlForm($Sections)
    if ($Actual -cne $Desired) { throw 'descriptor-readback' }
    [pscustomobject]@{ version = 1; denied = ($Operation -eq 'deny'); restored = ($Operation -eq 'restore'); exactDaclReadback = $true } | ConvertTo-Json -Compress
} catch {
    $Failure = [regex]::Replace($_.FullyQualifiedErrorId, '[^a-zA-Z0-9_.-]', '_')
    [Console]::Error.WriteLine('ACL_FIXTURE_' + $Operation.ToUpperInvariant() + '_FAILED:' + $Step + ':' + $Failure)
    exit 1
}
