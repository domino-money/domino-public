/**
 * The contracts of rugged97's public testnet rehearsal on Elysium Testnet (S5, mined 2026-09-29), as his evidence names
 * them (2026-10-01, the chain2 workstream).
 *
 * Why: the chain's deployment registry (config/chainElysium.ts ELYSIUM, his chains/deployments/elysium-v3-unqualified.json) is
 * unqualified and names no contract, so a qualified source of pools and vaults does not exist yet. His S5 rehearsal did
 * deploy a Uniswap v3 core (factory, position manager, router, quoter), two pools and four Domino vaults on the public
 * testnet, and recorded each address with its receipt (reports/elysium-v3-s5-2026-09-29/public-deployment.json at
 * 7d190690; a copy is tests/fixtures/elysium/s5-public-deployment.json, and tests/elysium-adapter.test.mjs holds every
 * address here equal to it). The section reads these in preview only, so the owner can test the screens against a real
 * chain: they are synthetic test tokens with a synthetic 1:1 starting price, no dollar value, and his record says so.
 * Production never reads them: the section is off there until a qualified deployment exists (flag.ts), and then the
 * registry's contracts replace this source entirely.
 *
 * Data only.
 */
export interface RehearsalPool {
  readonly id: string
  readonly address: string
  readonly token0: string
  readonly token1: string
  readonly fee: number
  readonly tickSpacing: number
  readonly createdAt: number
}

export interface RehearsalVault {
  readonly id: string
  readonly address: string
  readonly createdAt: number
}

export interface Rehearsal {
  /** Where the addresses come from: his repository, the commit, the file. */
  readonly source: { readonly commit: string; readonly path: string }
  readonly factory: string
  readonly positionManager: string
  readonly router: string
  readonly quoter: string
  /** The rehearsal's own wrapped-HYPE contract (backed by test HYPE deposits; not the canonical WHYPE). */
  readonly wrappedNative: string
  readonly factoryBlock: number
  readonly pools: readonly RehearsalPool[]
  readonly vaults: readonly RehearsalVault[]
}

export const ELYSIUM_REHEARSAL: Rehearsal = Object.freeze({
  source: Object.freeze({ commit: '7d1906907381c55e65d9b83ad1f3efafe1cabb36', path: 'reports/elysium-v3-s5-2026-09-29/public-deployment.json' }),
  factory: '0x6a42c29f28d4c27571a7e1c45d03839d828f0f32',
  positionManager: '0x9fb9c3e3afb23b32adca07b3efdbc6108d29f693',
  router: '0x025bc3110e51ebfc5249c8e1cd5900135af7f564',
  quoter: '0xd3ce4c4101dd123e00742255e929ea4ec0b4e7f8',
  wrappedNative: '0x7ef6768d84c2576849726b70fc41b50da33bb73f',
  factoryBlock: 940320,
  pools: Object.freeze([
    Object.freeze({ id: 'execution-synthetic-3000', address: '0x4b79c0e837ab70451bc849bf21d9ea3b25b69883', token0: '0x0337b5a6798e3bf57c262b56039afae357d57b5d', token1: '0x43695abf7df462d534bc738803cd9cd63154c190', fee: 3000, tickSpacing: 60, createdAt: 940620 }),
    Object.freeze({ id: 'gas-reference-synthetic-500', address: '0x59380fe65ae21f6e95798da4e21fe74d4686da1c', token0: '0x0337b5a6798e3bf57c262b56039afae357d57b5d', token1: '0x7ef6768d84c2576849726b70fc41b50da33bb73f', fee: 500, tickSpacing: 10, createdAt: 940647 }),
  ]),
  vaults: Object.freeze([
    Object.freeze({ id: 'direct-200', address: '0x385bfa95bbbdd8da06e31ff49f94f1296317e156', createdAt: 943423 }),
    Object.freeze({ id: 'direct-400', address: '0x53284e4390253d53f4f840db2883a46b3d30580b', createdAt: 943464 }),
    Object.freeze({ id: 'swap-200', address: '0x3bccb5486014db17f5a21375d06ac53b7ca765dd', createdAt: 943504 }),
    Object.freeze({ id: 'swap-400', address: '0xda2a5d55729702151fea74aaf269650096dc5978', createdAt: 943538 }),
  ]),
})
