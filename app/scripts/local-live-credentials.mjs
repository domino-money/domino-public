import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function credentialPath() {
  return process.platform === 'win32'
    ? resolve(homedir(), 'AppData/Local/Domino/local-live/access.json')
    : resolve(homedir(), '.config/domino/local-live/access.json')
}
export function within(file, root) {
  const fold = (s) => process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s
  const rel = relative(fold(root), fold(file))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
export function validateCredentials(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'clientId,clientSecret,version' && value.version === 1
    && typeof value.clientId === 'string' && /^[A-Za-z0-9_.-]{16,200}\.access$/.test(value.clientId)
    && typeof value.clientSecret === 'string' && /^(?:[0-9a-fA-F]{64}|cfast_[A-Za-z0-9]{48})$/.test(value.clientSecret)
}
export function readCredentials({ path = credentialPath(), forbiddenRoots }) {
  try {
    const resolved = realpathSync.native(path)
    const parent = dirname(resolved)
    if (forbiddenRoots.some((root) => within(resolved, realpathSync.native(root)))) throw new Error()
    // Reject every symlink/junction in the private path, and hard-linked files.
    for (let part = resolve(path); ; part = dirname(part)) {
      if (lstatSync(part).isSymbolicLink()) throw new Error()
      if (dirname(part) === part) break
    }
    const file = lstatSync(resolved)
    if (!file.isFile() || file.nlink !== 1 || file.size > 4096) throw new Error()
    if (process.platform === 'win32') {
      // Only a boolean exits PowerShell. Neither file content nor ACL/account
      // details enter diagnostics. Path is passed as data, never shell code.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve(import.meta.dirname, 'check-local-live-acl.ps1'), '-CredentialPath', resolved], { env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (output.trim() !== 'owner-only') throw new Error()
    } else {
      for (const entry of [file, lstatSync(parent)]) if (entry.uid !== process.getuid() || (entry.mode & 0o077)) throw new Error()
    }
    const value = JSON.parse(readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''))
    if (!validateCredentials(value)) throw new Error()
    return Object.freeze(value)
  } catch { throw new Error('Development credential file is missing, malformed, linked, inside a served checkout, or not owner-only. Use the private setup instructions; never paste credentials into chat.') }
}
