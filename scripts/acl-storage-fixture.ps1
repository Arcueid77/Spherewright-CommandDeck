param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][ValidateSet('inspect', 'deny', 'restore', 'protect-fixture', 'reset-auto-fixture', 'unexpected-rule-fixture', 'clear-rule-fixture')][string]$Operation,
    [string]$OriginalDacl,
    [string]$DeniedDacl,
    [string]$ExpectedOwnerGroup
)
$ErrorActionPreference = 'Stop'
$Step = 'scope'
function Read-DaclState([string]$Value) {
    $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Value)
    if ($null -eq $Descriptor.DiscretionaryAcl -or $Descriptor.DiscretionaryAcl.Count -eq 0 -or $Descriptor.DiscretionaryAcl.BinaryLength -gt 32768) { throw 'empty-or-large-dacl' }
    $Bytes = [byte[]]::new($Descriptor.DiscretionaryAcl.BinaryLength)
    $Descriptor.DiscretionaryAcl.GetBinaryForm($Bytes, 0)
    [pscustomobject]@{ raw = $Descriptor; bytes = $Bytes; base64 = [Convert]::ToBase64String($Bytes); control = [int]$Descriptor.ControlFlags }
}
function Test-ExactDacl([string]$Left, [string]$Right) {
    $LeftState = Read-DaclState $Left
    $RightState = Read-DaclState $Right
    # Windows can initialize SE_DACL_AUTO_INHERITED on a DACL write. It is
    # descriptor metadata, outside the ACL bytes. Every other bit stays exact.
    ($LeftState.base64 -ceq $RightState.base64) -and (($LeftState.control -band (-bnot 1024)) -eq ($RightState.control -band (-bnot 1024)))
}
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
    $OwnerGroupSections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $OwnerGroup = $Security.GetSecurityDescriptorSddlForm($OwnerGroupSections)
    if ($Operation -in @('deny', 'restore') -and $OwnerGroup -cne $ExpectedOwnerGroup) { throw 'owner-group-changed' }
    if ($Operation -eq 'inspect') {
        $Step = 'deny-rule'
        $Identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $Rule = [Security.AccessControl.FileSystemAccessRule]::new($Identity, [Security.AccessControl.FileSystemRights]::Write, [Security.AccessControl.AccessControlType]::Deny)
        $Security.AddAccessRule($Rule)
        $Planned = $Security.GetSecurityDescriptorSddlForm($Sections)
        if ($Current -ceq $Planned) { throw 'already-denied' }
        [pscustomobject]@{ version = 1; originalDacl = $Current; deniedDacl = $Planned; ownerGroup = $OwnerGroup; originalAcl = (Read-DaclState $Current).base64; deniedAcl = (Read-DaclState $Planned).base64 } | ConvertTo-Json -Compress
        exit 0
    }
    if ($Operation -in @('deny', 'restore') -and (-not $OriginalDacl.StartsWith('D:') -or -not $DeniedDacl.StartsWith('D:') -or
        $OriginalDacl.Length -gt 16384 -or $DeniedDacl.Length -gt 16384 -or $OriginalDacl -ceq $DeniedDacl)) { throw 'descriptor' }
    if ($Operation -eq 'protect-fixture') {
        $Security.SetAccessRuleProtection($true, $true)
        $Desired = $Security.GetSecurityDescriptorSddlForm($Sections)
    } elseif ($Operation -eq 'reset-auto-fixture') {
        $Desired = $Current
    } elseif ($Operation -in @('unexpected-rule-fixture', 'clear-rule-fixture')) {
        $Everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
        $ExtraRule = [Security.AccessControl.FileSystemAccessRule]::new($Everyone, [Security.AccessControl.FileSystemRights]::WriteData, [Security.AccessControl.AccessControlType]::Deny)
        if ($Operation -eq 'unexpected-rule-fixture') { $Security.AddAccessRule($ExtraRule) }
        else { $Security.RemoveAccessRuleSpecific($ExtraRule) }
        $Desired = $Security.GetSecurityDescriptorSddlForm($Sections)
    } elseif ($Operation -eq 'deny') {
        if (-not (Test-ExactDacl $Current $OriginalDacl)) { throw 'changed-before-deny' }
        $Desired = $DeniedDacl
    } else {
        if (Test-ExactDacl $Current $OriginalDacl) {
            [pscustomobject]@{ version = 1; restored = $true; alreadyOriginal = $true; ownerGroup = $OwnerGroup; autoInheritedMetadataChanged = (((Read-DaclState $Current).control -bxor (Read-DaclState $OriginalDacl).control) -band 1024) -ne 0 } | ConvertTo-Json -Compress
            exit 0
        }
        if (-not (Test-ExactDacl $Current $DeniedDacl)) { throw 'unexpected-permissions' }
        $Desired = $OriginalDacl
    }
    $Step = 'descriptor-write'
    # Set only the DACL, never the owner, group, SACL or integrity label.
    # https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CommandDeckAclFixtureNative {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern uint SetNamedSecurityInfoW(string name, uint objectType, uint information,
        IntPtr owner, IntPtr group, [In] byte[] dacl, IntPtr sacl);
    // Only for constructing the non-auto-inherited temporary regression case.
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetFileSecurityW(string name, uint information, [In] byte[] descriptor);
}
'@
    $Raw = [Security.AccessControl.RawSecurityDescriptor]::new($Desired)
    if ($null -eq $Raw.DiscretionaryAcl -or $Raw.DiscretionaryAcl.Count -eq 0 -or $Raw.DiscretionaryAcl.BinaryLength -gt 32768) { throw 'empty-or-large-dacl' }
    if ($Operation -eq 'protect-fixture') {
        # Fixture initialization explicitly turns inherited rules into explicit
        # rules. Normalize this representation before the expected readback.
        foreach ($Ace in $Raw.DiscretionaryAcl) { $Ace.AceFlags = [Security.AccessControl.AceFlags]([int]$Ace.AceFlags -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited)) }
        $Canonical = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, $Raw)
        $Desired = $Canonical.GetSddlForm($Sections)
        $Raw = [Security.AccessControl.RawSecurityDescriptor]::new($Desired)
    }
    if ($Operation -eq 'reset-auto-fixture') {
        $Raw.SetFlags([Security.AccessControl.ControlFlags]([int]$Raw.ControlFlags -band (-bnot 1024)))
        $Desired = $Raw.GetSddlForm($Sections)
    }
    $DaclBytes = [byte[]]::new($Raw.DiscretionaryAcl.BinaryLength)
    $Raw.DiscretionaryAcl.GetBinaryForm($DaclBytes, 0)
    $Information = [uint32]4
    if ($Operation -eq 'protect-fixture') { $Information = [uint32]2147483652 }
    if ($Operation -eq 'reset-auto-fixture') {
        $DescriptorBytes = [byte[]]::new($Raw.BinaryLength)
        $Raw.GetBinaryForm($DescriptorBytes, 0)
        if (-not [CommandDeckAclFixtureNative]::SetFileSecurityW($File, 4, $DescriptorBytes)) { throw ('native-fixture-error-' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    } else {
        $NativeError = [CommandDeckAclFixtureNative]::SetNamedSecurityInfoW($File, 1, $Information, [IntPtr]::Zero, [IntPtr]::Zero, $DaclBytes, [IntPtr]::Zero)
        if ($NativeError -ne 0) { throw ('native-dacl-error-' + $NativeError) }
    }
    $ActualSecurity = Get-Acl -LiteralPath $File
    $Actual = $ActualSecurity.GetSecurityDescriptorSddlForm($Sections)
    if (-not (Test-ExactDacl $Actual $Desired)) {
        $ActualRaw = [Security.AccessControl.RawSecurityDescriptor]::new($Actual)
        function Get-AclFacts($Descriptor) {
            $Hasher = [Security.Cryptography.SHA256]::Create()
            try { foreach ($Ace in ($Descriptor.DiscretionaryAcl | Select-Object -First 8)) {
                $SidHash = [BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Ace.SecurityIdentifier.Value))).Replace('-', '').Substring(0, 12)
                '{0}:{1}:{2}:{3}' -f [int]$Ace.AceType, [int]$Ace.AceFlags, $Ace.AccessMask, $SidHash
            } } finally { $Hasher.Dispose() }
        }
        $Diff = [pscustomobject]@{ desiredControl = [int]$Raw.ControlFlags; actualControl = [int]$ActualRaw.ControlFlags; desiredAceCount = $Raw.DiscretionaryAcl.Count; actualAceCount = $ActualRaw.DiscretionaryAcl.Count; desiredAces = @(Get-AclFacts $Raw); actualAces = @(Get-AclFacts $ActualRaw) }
        [Console]::Error.WriteLine('ACL_FIXTURE_DESCRIPTOR_DIFF:' + ($Diff | ConvertTo-Json -Compress))
        throw 'descriptor-readback'
    }
    if ($ActualSecurity.GetSecurityDescriptorSddlForm($OwnerGroupSections) -cne $OwnerGroup) { throw 'owner-group-changed' }
    $ActualControl = (Read-DaclState $Actual).control
    if ($Operation -eq 'reset-auto-fixture' -and ($ActualControl -band 1024)) { throw 'fixture-auto-bit-not-reset' }
    [pscustomobject]@{ version = 1; denied = ($Operation -eq 'deny'); restored = ($Operation -eq 'restore'); protectedFixture = ($Operation -eq 'protect-fixture'); nonAutoFixture = ($Operation -eq 'reset-auto-fixture'); unexpectedRuleFixture = ($Operation -eq 'unexpected-rule-fixture'); clearedRuleFixture = ($Operation -eq 'clear-rule-fixture'); exactDaclReadback = $true; daclOnly = $true; ownerGroup = $OwnerGroup; autoInheritedMetadataChanged = (($ActualControl -bxor [int]$Raw.ControlFlags) -band 1024) -ne 0 } | ConvertTo-Json -Compress
} catch {
    $Failure = [regex]::Replace($_.FullyQualifiedErrorId, '[^a-zA-Z0-9_.-]', '_')
    [Console]::Error.WriteLine('ACL_FIXTURE_' + $Operation.ToUpperInvariant() + '_FAILED:' + $Step + ':' + $Failure)
    exit 1
}
