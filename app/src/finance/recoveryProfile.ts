import { deploymentFrom, type SetupDeployment } from './setup'

/**
 * The setup deployment profile this browser keeps for owner recovery: the
 * published release as it was when the wallet last verified it on chain
 * (Setup's owner recovery, Create position and the refund of a held deposit
 * on Positions save it). Public identities only: no wallet, operation,
 * amount or credential enters storage.
 *
 * Read back when the release is switched off, expired or out of reach. It can
 * then only read and refund: the setup client's recovery checks (setup.ts
 * verify with `recovery`) look at the setup contract's code and getters on
 * chain, and the profile is marked expired so it never funds, swaps or mints.
 */
export const SETUP_RECOVERY_KEY = 'domino.setup.public-recovery.v1'
const MAX_CHARS = 8192

/** The saved profile, parsed as strictly as the release at any age, or null when there is none or it does not parse. */
export function savedSetupProfile(): SetupDeployment | null {
  try {
    const saved = localStorage.getItem(SETUP_RECOVERY_KEY)
    if (saved && saved.length <= MAX_CHARS) {
      const old = deploymentFrom(JSON.parse(saved), 0)
      if (old) return { ...old, expiresAt: 0 }
    }
  } catch {
    /* Storage is optional; a profile that does not parse is no profile. */
  }
  return null
}

/** Keeps a profile the wallet just verified, for recovery when none is published. */
export function saveSetupProfile(deployment: SetupDeployment): void {
  try {
    localStorage.setItem(SETUP_RECOVERY_KEY, JSON.stringify({ contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment }))
  } catch {
    /* Recovery can also use the published deployment profile. */
  }
}
