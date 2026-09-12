import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, linkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { test } from 'node:test'
import { readCredentials } from '../scripts/local-live-credentials.mjs'

test('private synthetic file must be owner-only, outside roots and not hardlinked; Windows setup parses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'domino-private-credential-test-'))
  const path = join(dir, 'access.json')
  const body = { version: 1, clientId: 'synthetic-local-test-132.access', clientSecret: 'e'.repeat(64) }
  writeFileSync(path, JSON.stringify(body))
  try {
    const roots = [resolve(import.meta.dirname, '..')]
    if (process.platform === 'win32') {
      assert.throws(() => readCredentials({ path, forbiddenRoots: roots }), /owner-only/)
      const literal = (s) => `'${s.replaceAll("'", "''")}'`
      const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; foreach($p in @(${literal(dir)},${literal(path)})) { $a=Get-Acl -LiteralPath $p; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)) {$a.RemoveAccessRuleSpecific($r)}; $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')); Set-Acl -LiteralPath $p -AclObject $a }; $errors=$null; $tokens=$null; $null=[Management.Automation.Language.Parser]::ParseFile(${literal(resolve(import.meta.dirname, '../scripts/setup-local-live.ps1'))},[ref]$tokens,[ref]$errors); if($errors.Count -gt 0){exit 1}`
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, stdio: 'pipe' })
    } else { chmodSync(dir, 0o700); chmodSync(path, 0o600) }
    assert.deepEqual(readCredentials({ path, forbiddenRoots: roots }), body)
    assert.throws(() => readCredentials({ path, forbiddenRoots: [dir] }), /served checkout/)
    const alias = join(dir, 'other.json'); linkSync(path, alias)
    assert.throws(() => readCredentials({ path, forbiddenRoots: roots }), /linked/)
    unlinkSync(alias)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
