# V2 contracts: audit package

This package is for an external reviewer starting cold. It covers:
- what is frozen and how to rebuild it byte for byte;
- what is in scope;
- who can do what;
- every finding raised internally, with its disposition;
- the adversarial suite, and how to rerun it rather than trust it;
- the known limits.

It states limitations as plainly as capabilities.

Process, scope and tags: [docs/v2/FREEZE.md](../docs/v2/FREEZE.md). Design references per front: `docs/v2/F0_INTERFACES.md` … `F4_AUTO_EXIT.md`, `F1_FEES_ROUTE.md`, `F1_POSITIONS.md`, `F1_REGISTRY_ANCHOR.md`, `DEPLOYMENT.md`.

## 1. Freeze

- **Audit checkout:** the annotated tag `v2-audit-2026-10-04` (object `ca9aede4ab55de02db39d8714f60abf620515cfb`) on commit `5e63d2dba9123fdc585f7f272b83532b491fbc51`, tree `db8bfb4e57a043a94f7fe55bf02725cb65836b1c`. #319's CI run [37201444263](https://github.com/domino-money/domino/actions/runs/37201444263) passed every job on this tree. Main's run on the commit itself, [37206891445](https://github.com/domino-money/domino/actions/runs/37206891445), is recorded in [`reports/v2-audit-2026-10-04/freeze.json`](v2-audit-2026-10-04/freeze.json).
- **Trust root:** `contracts/release-artifacts-v2.json`, SHA-256 `4f607c2f0ee6c58f156453147fac19029f90b1437613ec3ad228242938436ebb` (`sourceTreeSha256` `296008a420406c857706033149e39d17fba544061507ee9ad0ed06a199f75ad9`). It pins:
  - the compiler (solc-js `0.8.26+commit.8a97fa7a`, via-IR, 200 runs, `cancun`, `bytecodeHash: none`);
  - the 52 sources;
  - the deployment tool's files;
  - for each of the 12 contracts: creation and runtime hashes and sizes, immutable offsets and ABI hash.

To rebuild and compare:

```bash
npm ci && npm --prefix app ci
(cd contracts && node ../scripts/test-contracts.mjs build src/v2/registry/DominoRegistry.sol src/v2/anchor/DominoPriceAnchor.sol src/v2/autoexit/DominoAutoExit.sol src/v2/vault/DominoV2VaultSwapModule.sol src/v2/vault/DominoV2VaultV3.sol src/v2/vault/DominoV2VaultV4.sol src/v2/vault/DominoV2VaultFactory.sol src/v2/zap/DominoZapV3.sol src/v2/zap/DominoZapV4.sol src/v2/zap/DominoZapV4Steps.sol)
node scripts/v2/release-manifest.mjs --check --forge-out contracts/out
```

- **What that command proves:** the manifest equals an independent solc-js compile of every V2 source (`deploy.mjs`'s `compileV2`). It also proves that the Foundry artifacts the tests deploy are the same contracts, byte for byte.
- **The deploy binding:** `deploy.mjs` refuses a public preparation from anything else. A deployment manifest's `build.sourceTreeSha256` equals the release manifest's.

| Contract | Runtime | Creation | Immutables |
|---|---:|---:|---:|
| DominoRegistry | 7,091 B | 8,757 B | 0 |
| DominoPriceAnchor | 7,529 B | 8,288 B | 15 |
| DominoAutoExit | 19,710 B | 20,526 B | 21 |
| DominoV2VaultSwapModule | 7,382 B | 7,905 B | 7 |
| DominoV2VaultV3 (clone implementation) | 15,923 B | 37,320 B | 30 |
| DominoV2VaultExecutorV3 | 19,688 B | 20,435 B | 14 |
| DominoV2VaultV4 (clone implementation) | 15,941 B | 41,141 B | 35 |
| DominoV2VaultExecutorV4 | 23,442 B | 24,203 B | 16 |
| DominoV2VaultFactory (one per DEX) | 1,470 B | 2,141 B | 5 |
| DominoZapV3 | 23,554 B | 24,509 B | 15 |
| DominoZapV4 | 21,110 B | 22,018 B | 17 |
| DominoZapV4Steps | 7,394 B | 7,433 B | 1 |

The largest runtime is DominoZapV3's: 1,022 B under EIP-170's 24,576 B.

## 2. Scope

**In scope: 52 files under `contracts/src/v2`, 8,039 lines.**

| Module | Files | Lines | What it is |
|---|---:|---:|---|
| `registry/` | 1 | 385 | Roles and lists per chain; 24 h timelock; the guardian narrows only |
| `anchor/` | 2 | 336 | Signed observations or v3 TWAP; band against the live spot |
| `route/` | 5 | 733 | Swap-leg executor (v3 paths, v4 paths, admitted Universal Router), floor, token ops, action lock |
| `fees/` | 2 | 253 | Fee rules (65 bps assisted swap, 2%/4% automation, 20 bps auto-exit) and the owed-fee ledger |
| `positions/` | 13 | 1,899 | v3/v4 position adapters and position math; 10 of the files (997 lines) are Uniswap math vendored from upstream |
| `zap/` | 4 | 794 | S1: create, increase, change range, exit, in one transaction, NFT in the wallet |
| `vault/` | 10 | 1,877 | Automation: clones per owner, the executor (delegatecall), the swap module, plan v1 |
| `autoexit/` | 1 | 475 | Owner-signed exit mandates, executed by the operator, 0.2% tariff |
| `interfaces/`, `external/`, top-level types | 14 | 1,287 | F0's frozen interfaces, minimal Uniswap and Permit2 interfaces, shared types |

Also in scope, as the deployment tool:
- `scripts/v2/deploy.mjs`, `deploy-schema.mjs`, `deploy-manifest.schema.json` and `release-manifest.mjs`;
- the two shared files they run: `scripts/solc-compile.cjs` and `scripts/prepare-financial-release.mjs`.

The tool prepares unsigned CREATE3 transactions (CreateX), preflights them against the chain and verifies a deployment read-only. It signs and sends nothing.

**The vendored math** (`positions/uniswap/`) differs from its reference copies only by the edits `scripts/v2/position-fixtures.mjs check` records.

**Out of scope:**
- The backend (planner, signer, executor, indexer), the app, the Cloudflare workers and `api-contracts`.
- The V1 contracts (their own freeze: `v4-audit-2026-09-21`, `v1-release-2026-09-21`).
- The Elysium-v3 drafts (#258–#277).

## 3. Trust model

No V2 contract is upgradeable and none has an admin beyond what is described here.

| Role | Set by | Can | Cannot |
|---|---|---|---|
| **Owner** (of a vault, of a position) | whoever creates the vault or holds the NFT | everything on their vault: policy and limits within the vault's ceilings, pause/resume, rearm, withdraw reserves to any recipient, withdraw children, recover unaccounted tokens and positions, exitAll, enable/disable the auto-exit module; sign exit mandates, revoke them, cancel nonces | spend owed fees |
| **Operator** (registry list, global) | governance, timelocked | `execute` plans on any vault (compound, mint a successor, swap from a source's lots), `pause` any vault, `operatorRearm` (v3, only-liquidity-added), execute auto-exit mandates | resume, change limits, withdraw, move a position out, act on a paused vault or under the halt |
| **Publisher** (registry list) | governance, timelocked | sign price observations | anything on a vault; an observation is void once the epoch passes it |
| **Guardian** | governance, timelocked | immediately: remove an operator, publisher or router; raise the observation epoch; halt automation | add or loosen anything |
| **Governance** (a 2-of-3 Safe on each chain) | `transferGovernance` → `acceptGovernance` | schedule changes (operators, publishers, routers, charge currencies, fee recipient, guardian), executed after 24 h; cancel them | act on a vault or a position |
| **Fee recipient** | governance, timelocked | receive fees; unpaid fees stay owed in the contract that charged them, and anyone may flush them | — |

**What a compromised operator can cost:**
- **The owner's limits bound it, and the vault caps those limits:** slippage ≤ 10%, anchor band ≤ 5%, observation age ≤ 300 s, interval ≥ 600 s.
- **Per execution:** a route must deliver the floor, which is the anchor quote less the pool fee and the slippage. An observation it picks within the age can sit anywhere in the band. So the most an operator's swap can lose per execution is about band + pool fee + slippage of the amount swapped. `HostileOperator.t.sol` measures this on the wired world.
- **Auto-exit:** the operator chooses the moment (after a crossing), the evidence (a fresh admitted observation, or a v3 TWAP of 600 s to one hour) and the legs (each checked by its effect, the whole route held to the floor). Its worst case is the mandate's slippage plus the band's offset of the anchor (see §7).
- **Liveness:** any operator can pause any vault (A4, accepted). The owner resumes, and owner exits never wait for a pause.

**What a compromised publisher can cost:** observations within the band of the live spot, so the same bound. The guardian voids them by raising the epoch.

**What a compromised guardian can cost:** liveness only (halt, removals). It cannot add or loosen anything. Replacing it takes two timelocks and one second (RegistryAttacks).

## 4. Invariants and where they are tested

| | Invariant | Enforced in | Tested by |
|---|---|---|---|
| I1 | Vault: balance(T) ≥ owed(T) + idle(T) + Σ lots(T) | measured deltas everywhere; `recoverToken` | `invariant/VaultLedgerInvariants`, `invariant/WiredVaultInvariants` (exact, v3 and v4), `adversarial/TokenMatrixVaultInvariants` (hostile tokens), integration `_ledgerBalanced` |
| I2 | Owed fees are never spent; only a flush pays them | `FeeNotBacked` after legs (F-01); a hop pays what arrived (F-03); an exact payout measures its debit (F-04); `_unowedBalance` | `invariant/ZapLedgerInvariants`, `invariant/ZapV4LedgerInvariants`, `invariant/VaultLedgerInvariants`, `adversarial/HopTokenBacking`, `adversarial/TokenMatrix*` |
| I3 | Fee ≤ rate (65 bps, 2%/4%, 20 bps) | FeeRules, executor, auto-exit | `VaultLedgerInvariants` and `WiredVaultInvariants` (per execution), `AutoExitInvariants` (per exit), unit and fuzz suites |
| I4 | Swap floors from the anchor | vault, auto-exit; the zap uses the user's signed minimums | `HostileOperator`, `AutoExitAttacks`, `AutoExitInvariants`, journeys |
| I5 | Exact input per leg; no allowance survives | SwapExecutor effect checks | `ZapLedgerInvariants`, `ZapV4LedgerInvariants`, `TokenMatrixZapInvariants`, router suites |
| I6 | Only the owner withdraws; funds go only to the owner, the module or the named recipient | onlyOwner, returnReserves | `VaultLedgerInvariants`, `WiredVaultInvariants`, Owner/Return/Exit suites |
| I8 | Auto-exit fires only across the anchor, inside the band, once, on an enabled vault and its owner | AutoExit, executor | `adversarial/AutoExitInvariants`, `AutoExitAttacks`, `AutoExitVaultAttacks`, auto-exit unit suites |
| I9 | Anchor freshness, signer, epoch, TWAP window (600 s to 1 h), band | Anchor, AutoExit | anchor suites, `AutoExitInvariants`, `AutoExitAttacks`, `RegistryInvariants` |
| I10 | The vault touches only the armed, live root; owner changes disarm | executor, V3/V4 | Custody suites |
| I12 | The state nonce only grows | storage | `VaultLedgerInvariants`, `WiredVaultInvariants` |
| I13 | Registry: timelock, readmission rules, disjoint roles, epoch only grows | Registry | `adversarial/RegistryInvariants`, `RegistryAttacks`, `WiredRegistryAttacks` |
| I15 | One action lock; callbacks authenticated | ActionLock, SwapExecutor | route suites, `ZapLedgerInvariants` (router re-entry), journeys |
| I16 | Auto-exit: balance(T) ≥ owed(T) + unclaimed credits(T) | AutoExit | `adversarial/AutoExitInvariants` |

## 5. Findings raised internally

| ID | Severity (ours) | What | Disposition |
|---|---|---|---|
| F-01 | High | A zap leg could spend fees the zap owes, in a token outside the action's own | Fixed (#317): after the legs, every leg input must still back what is owed in it |
| F-02 | High | A Universal Router leg could carry position-manager commands, which the router authorises by its caller (a Domino contract) | Fixed (#317): router legs accept only swap, payment, Permit2-pull, wrap and balance-check commands |
| F-03 | Medium | A direct v3 multi-hop leg paid each hop the pool's reported output, so a buy-taxed hop token was made up from the contract's own balance (owed fees in the zap, recoverable tokens in the vault, deferred deliveries in the auto-exit) | Fixed (#319): each hop pays forward what arrived. Regressions: `HopTokenBacking`, `HostileOperator` V3 |
| F-04 | Low | The zap's refund and the vault's exact payouts (`withdrawReserves`, `recoverToken`, the exit module's delivery) read nothing back, so a token that debits its sender more than the amount spent fees owed in it (and, in the vault, other reserves in it) | Fixed (#319): each exact payment measures its own debit and refuses one that took more than it moved (`TokenCallFailed`). The best-effort sweeps keep A8 (§7) |
| B | Known limit | A double-entry token (two addresses moving one balance): owed fees and reserves are kept per address, so that token's own owed fees can be refunded or recovered through its twin | Accepted: only that token's fees are exposed; such tokens are not supported. Pinned by `testKnownLimit_*` in `TokenMatrixZap` and `TokenMatrixVault` |
| D-1 | Design | The auto-exit's TWAP window had no ceiling: a 6,500 s window fired a stop on a dip from before the owner signed, which the 600 s window never saw; only the band bounded it | Changed by the owner (3 Oct): `MAX_TWAP_SECONDS` = 3,600, `TwapWindowTooLong`; the constructor refuses a larger floor |
| D-2 | Design | `exitAll` left the exit module enabled: an active stop still removed the root the owner had taken back (liquidity added afterwards included) and charged 20 bps | Changed by the owner (3 Oct): `exitAll` disables the module (`ExitModuleSet(0, nonce)`); enabling it again revives the owner's active mandates |
| V1 audit A1–A14, B1–B8 | — | Carried over to V2 | See `docs/v2/F3_VAULT.md`. The owner's decisions of 3 Oct: A8 fixed (`withdrawReserves` recipient); A3, A4, A10, A14 and B4 accepted; `returnReserves` refused while a successor is active |

The registry suites found no code defect. They pinned four operational rules, now in `docs/v2/F1_REGISTRY_ANCHOR.md`:
- **A leaked key** is removed from both roles: removal is per role, so a pending admission to the other role stays executable. It is never re-admitted: its future-dated observations escape the epoch, which never passes the clock.
- **The governance hand-over** is immediate and outside the guardian's veto, and an offer never expires: monitoring watches `GovernanceTransferStarted`. Governance is never handed to the guardian's address, which would merge the roles.
- **A compromised guardian** costs exactly two timelocks and one second.
- **The timelock's value** is the one setting no constructor event carries.

## 6. The adversarial suite

Under `contracts/test/v2/invariant` and `contracts/test/v2/adversarial`. The wired suites deploy the V2 contracts from their Foundry artifacts (the same bytes as the manifest) on Base's deployed Uniswap v3 and v4 bytecode, Robinhood's Permit2 and an admitted router. Tests that pin a limit are named `testKnownLimit_*`; tests that pin an accepted behaviour cite the doc line that makes it one.

| Suite | Tests | What it proves |
|---|---:|---|
| `invariant/VaultLedgerInvariants` | 7 | Stateful, every party on a Domino vault (v3 unit model): I1, I2, I3, I12, the sequence's consistency, the limits inside the vault's ceilings |
| `invariant/WiredVaultInvariants` | 4 × 2 | Stateful, an Auto-compound vault on the real registry, anchor, swap module and Uniswap (v3 and v4): balances exactly the ledger, ≤ 2% of what was taken, exact free withdrawals, owed fees fall only by a flush |
| `invariant/ZapLedgerInvariants` | 4 | Stateful, the v3 zap: users, random router scripts, the F-01 shape, traders, a dark recipient; I2, nothing kept, no allowance or position |
| `invariant/ZapV4LedgerInvariants` | 4 | The same on the v4 zap, native currency included |
| `adversarial/HopTokenBacking` | 3 | F-03 on the zap |
| `adversarial/HostileOperator` | 4 + 3 | The operator's bounds on the wired world: the floor to the unit, an observation at the band's edge, a pause never holds the owner's money; F-03 on the vault (v3) |
| `adversarial/TokenMatrixFees` | 9 | Nineteen ERC-20 behaviours against F1b's fee ledger: the push cap, the owed fallback, exact flushes, burners and 4 MB return bombs |
| `adversarial/TokenMatrixZap` | 11 | The same behaviours in 11 roles of the v3 zap, each completed action settled against its events; F-04 and B |
| `adversarial/TokenMatrixZapInvariants` | 5 | The zap while the token switches behaviour between actions |
| `adversarial/TokenMatrixVault` | 15 | Every flow that moves a vault's token with either pool token hostile; amounts above 2^128 refused, never truncated; F-04 and B |
| `adversarial/TokenMatrixVaultInvariants` | 5 | The vault while both tokens switch behaviour |
| `adversarial/ReturnBomb` | 6 | The gas the owner's exits need under burners and 10 MB return bombs, and who pays for a return payload |
| `adversarial/RegistryInvariants` | 8 | Stateful, against a model written from F1: no change before its timelock, re-admission and resume rules, disjoint roles, the epoch, every party within its rights, the registry rebuilt from its events |
| `adversarial/RegistryAttacks` | 20 | The hand-over, the guardian front-running and its replacement, removals across roles, routers below 2.1.2, re-admissions, future-dated observations |
| `adversarial/WiredRegistryAttacks` | 8 | A rank change between an S1 signature and its execution; the halt on the vault and the auto-exit; the owner exits under the halt and with the registry gone |
| `adversarial/HaltOwnerExits` | 3 | Under the halt, and with every registry call reverting, the owner's exits all run |
| `adversarial/AutoExitInvariants` | 10 | Stateful, every party around the auto-exit (owners, operator, publishers, guardian, governance, hostile vaults and tokens): I8, I9, I16, the 20 bps rule, conservation, the floor, the removal minimums, single-use nonces, exact claims and flushes; a seeded 2,000-step walk and a negative control for the auditor |
| `adversarial/AutoExitAttacks` | 25 | The TWAP window's bounds (D-1), stale and replayed observations, a publisher rotation, the halt, hostile routes, a vault no factory made, consent, front-running a revoke |
| `adversarial/AutoExitVaultAttacks` | 5 × 2 | On the real vault (v3 and v4): an exit while paused, `exitAll` disabling the module (D-2), the halt at the module and at the vault |

**Mutation.** Each guard was deleted or weakened in a copy and the suites rerun:
- the auto-exit: 29 of 29 caught (sandbox copy, the module's artifact rebuilt per mutant);
- the registry: 18 of 18 hand-made mutants caught;
- the 3 Oct decisions' five guards: 5 of 5 caught.

Mutation batches for the fees/route and positions code are in `contracts/mutations/`, run by hand.

**How to run:** one suite at a time, after the build above (a whole-tree run exhausts solc-js memory):

```bash
node scripts/test-contracts.mjs --match-path test/v2/adversarial/AutoExitInvariants.t.sol
```

Invariant depth is set per suite (`/// forge-config: default.invariant.runs/depth`). Each harness has a scripted test (`testTheHandlerReachesEveryAction` or similar) proving every action reaches the contract, so a campaign that only ever reverted cannot pass.

CI runs these 19 suites as the `Contracts (v2-audit)` job. The other V2 suites, the ABI and fixture checks and their gas baseline run as `Contracts (v2)`, and the manifest is reproduced in `Backend`. Each part checks the gas entries of its own suites.

## 7. Known limits

On 4 Oct 2026 the owner accepted four of these:
- the two hostile-token limits (the sweeps, the double-entry token B);
- the anchor at the band's edge;
- the auto-exit fee following the ranks.

- **No fork tests in CI** (no network). The suites etch the bytecode deployed on Base and Robinhood instead (`positions/fixtures`, `route/fixtures`). The fork rehearsal of 2 Oct deployed the configuration on forks of the three chains (`docs/deployments/v2-rehearsal-2026-10-02`).
- **No symbolic execution and no third-party static analysis yet.**
- **Hostile tokens:**
  - A token that debits its sender more than it moves can still spend fees owed in itself through the best-effort sweeps (`exitAll`, `returnReserves`, `_release`). A8 keeps them from reverting over one token, so they do not refuse it. Accepted and pinned.
  - A double-entry token (B), above.
  - A transfer that reports success without moving, one that moves but returns false, a lying `balanceOf`, an additive `approve` and a negative rebase are pinned as accepted or informational behaviours.
- **`exitAll` gas grows with members and with hostile tokens.** The ladder fits at most about 216 members before MAX_TICK. Both pool tokens burning gas take `exitAll` to 28–32M gas (ReturnBomb). If `exitAll` ever exceeds a transaction's gas, the owner withdraws children one by one.
- **The auto-exit's anchor can sit at the band's edge.** The operator chooses the evidence within the mandate's band, so the floor stacks on the band: with a 1% mandate on a 0.3% pool, the owner's token sells at 97.8% of its spot value instead of 98.7%. This is accepted by F4 (the floor is against the anchor) and pinned by `testAnAnchorAtTheBandsEdgeStacksTheBandOnTheFloor`.
- **The auto-exit fee follows the registry's ranks at execution.** No mandate signs it.
- **Operator trust is bounded, not removed:** see §3.
