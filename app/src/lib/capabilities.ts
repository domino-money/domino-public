import { ROBINHOOD_ID } from '../config/chainIdentity'

/** Build capabilities, and where each automation stands (the pill Automate, Home, Positions and the docs show).
 * Wallet transactions are prepared locally and require a separate wallet
 * review. Runtime activation comes from the verified deployment/services;
 * these constants never authorize a transaction or establish a session.
 */
export const CAPABILITIES = {
  version: 1,
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G3): the chain registry's id, the same 4663.
  chainId: ROBINHOOD_ID,
  // What this build switches on by itself: nothing that spends. Domino V1 is
  // deployed on Robinhood Chain (docs/V1_MAINNET_FRONTEND_HANDOFF_0XDECIMAL.md),
  // and the owner funds, swaps and mints in Setup and creates or manages a
  // sequence with their own wallet; those flows are admitted at run time by
  // the release endpoints (finance/release.ts), never by these flags. The
  // build itself never signs automation transactions. The external operator
  // is checked for each owner and sequence at run time, not by this flag.
  signingEnabled: false,
  walletFundingEnabled: false,
  // Every deployable build carries wallet sign-in. Whether a session can be
  // established is the session service's call, never this flag.
  walletSignInBuilt: true,
  walletTransactionsBuilt: true,
  privateHistoryBuilt: true,
  // Every build that can be deployed carries the read path. Whether any read
  // is enabled is the server's call, in its capabilities answer, never this flag.
  liveReadsBuilt: true,
  // Setup's assisted swap is the owner's own wallet step, admitted like the
  // rest; an automatic balancing swap belongs to an admitted sequence's cycle.
  swapsEnabled: false,
} as const

/**
 * Where a ROADMAP entry stands. `connected`: the owner's own wallet does it
 * here, one reviewed step at a time. `owner-scoped`: a sequence starts paused
 * and activation depends on the signed-in owner's live service check for that
 * exact vault. `not-connected`: nothing of it reaches this app. `planned`:
 * terms stated as they stand, nothing to connect.
 */
export type Availability = 'planned' | 'not-connected' | 'owner-scoped' | 'connected'

/**
 * The pill a status wears, where it wears one. A connected or planned entry
 * wears none: a "Planned" pill would call the product unfinished and a
 * "Connected" pill would be a claim. The words say where it stands, never a
 * colour.
 */
export const ROADMAP_PILL: Partial<Record<Availability, string>> = {
  'not-connected': 'Not connected',
  // Changed on purpose 2026-10-01 (audit E3): "Per sequence" named an internal scope and explained nothing to a visitor.
  'owner-scoped': 'Starts paused',
}

/** What a pill means, in a sentence: its title, for whoever hovers or focuses it (audit E3). */
export const ROADMAP_PILL_TITLE: Partial<Record<Availability, string>> = {
  'not-connected': 'Nothing of it reaches this site yet.',
  'owner-scoped': 'Each automation starts paused. Once Domino’s automation service is ready for it, its position’s page offers Turn on.',
}

/**
 * Where each automation stands today, by the name its pill is asked for (RoadmapPill in screens/Automate.tsx).
 * Changed on purpose (2026-09-27, the owner's round 6, point 6): the Settings page that listed these with a note each is
 * gone, and the notes with it, along with the three rows only it showed (Fee-balancing swaps, Wallet permissions and
 * Service pricing). What they said is in the docs: What Domino is, Auto-compound, Domino Compounder, Non-custodial and Fees.
 */
export const ROADMAP: ReadonlyArray<{ name: string; status: Availability }> = [
  { name: 'Compound', status: 'owner-scoped' },
  { name: 'Domino', status: 'owner-scoped' },
]
