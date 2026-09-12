# Run locally in a private terminal after independent review and provisioning.
# Secret inputs use hidden prompts, never command arguments or browser storage.
$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$dominoDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Domino\local-live'
$dominoFile = Join-Path $dominoDir 'access.json'
$dominoSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
# A junction ABOVE the new directory could otherwise write a credential into
# a served checkout before the launcher's later checks ever run.
$dominoAncestor = $dominoDir
while ($dominoAncestor) {
  if (Test-Path -LiteralPath $dominoAncestor) {
    $dominoEntry = Get-Item -Force -LiteralPath $dominoAncestor
    if (($dominoEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private credential ancestry contains a link or reparse point. Nothing was written.' }
  }
  $dominoAncestor = [IO.Path]::GetDirectoryName($dominoAncestor)
}
$dominoRepo = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not verify checkout boundary. Nothing was written.' }
$dominoCommon = (& git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not verify primary checkout boundary. Nothing was written.' }
foreach ($dominoRoot in @($dominoRepo, [IO.Path]::GetDirectoryName($dominoCommon))) {
  $dominoPrefix = [IO.Path]::GetFullPath($dominoRoot).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
  if ([IO.Path]::GetFullPath($dominoDir).StartsWith($dominoPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Private credentials must be outside every checkout and served root. Nothing was written.' }
}
if (Test-Path -LiteralPath $dominoFile) { throw 'A credential already exists. Coordinate revocation/rotation before replacing this file.' }
if (Test-Path -LiteralPath $dominoDir) {
  if (-not (Get-Item -LiteralPath $dominoDir).PSIsContainer -or @(Get-ChildItem -Force -LiteralPath $dominoDir).Count -ne 0) { throw 'The private directory is not empty. Nothing was changed.' }
  $dominoAcl = Get-Acl -LiteralPath $dominoDir
  if ($dominoAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $dominoSid.Value -or -not $dominoAcl.AreAccessRulesProtected) { throw 'Existing private directory is not owner-only. Nothing was changed.' }
  foreach ($dominoRule in $dominoAcl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
    if ($dominoRule.AccessControlType -eq 'Allow' -and $dominoRule.IdentityReference.Value -ne $dominoSid.Value) { throw 'Existing private directory is not owner-only. Nothing was changed.' }
  }
} else {
  $null = New-Item -ItemType Directory -Path $dominoDir
  $dominoAcl = [System.Security.AccessControl.DirectorySecurity]::new()
  $dominoAcl.SetOwner($dominoSid)
  $dominoAcl.SetAccessRuleProtection($true, $false)
  $dominoAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($dominoSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $dominoDir -AclObject $dominoAcl
}
$dominoIdInput = Read-Host 'Dedicated development Client ID (hidden)' -AsSecureString
$dominoSecretInput = Read-Host 'Dedicated development Client Secret (hidden)' -AsSecureString
$dominoIdPtr = [IntPtr]::Zero
$dominoSecretPtr = [IntPtr]::Zero
try {
  $dominoIdPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($dominoIdInput)
  $dominoSecretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($dominoSecretInput)
  $dominoId = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($dominoIdPtr)
  $dominoSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($dominoSecretPtr)
  if ($dominoId -notmatch '^[A-Za-z0-9_.-]{16,200}\.access$' -or $dominoSecret -cnotmatch '^(?:[0-9a-fA-F]{64}|cfast_[A-Za-z0-9]{48})$') { throw 'Credential format is not recognized. No secret was written.' }
  $dominoJson = @{ version=1; clientId=$dominoId; clientSecret=$dominoSecret } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($dominoFile, $dominoJson, [Text.UTF8Encoding]::new($false))
  $dominoFileAcl = [System.Security.AccessControl.FileSecurity]::new()
  $dominoFileAcl.SetOwner($dominoSid)
  $dominoFileAcl.SetAccessRuleProtection($true, $false)
  $dominoFileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($dominoSid, 'FullControl', 'Allow'))
  Set-Acl -LiteralPath $dominoFile -AclObject $dominoFileAcl
  Write-Output 'Dedicated development credential saved outside the checkout with owner-only access. Nothing was activated or contacted.'
} finally {
  if ($dominoIdPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($dominoIdPtr) }
  if ($dominoSecretPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($dominoSecretPtr) }
  $dominoIdInput.Dispose(); $dominoSecretInput.Dispose()
  $dominoId = $null; $dominoSecret = $null; $dominoJson = $null
}
