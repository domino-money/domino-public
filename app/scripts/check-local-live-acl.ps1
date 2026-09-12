param([Parameter(Mandatory=$true)][string]$CredentialPath)
$ErrorActionPreference = 'Stop'
try {
  $dominoSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach ($dominoPath in @($CredentialPath, [IO.Path]::GetDirectoryName($CredentialPath))) {
    $dominoAcl = Get-Acl -LiteralPath $dominoPath
    if ($dominoAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $dominoSid.Value -or -not $dominoAcl.AreAccessRulesProtected) { exit 1 }
    foreach ($dominoRule in $dominoAcl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
      if ($dominoRule.AccessControlType -eq 'Allow' -and $dominoRule.IdentityReference.Value -ne $dominoSid.Value) { exit 1 }
    }
  }
  Write-Output 'owner-only'
} catch { exit 1 }
