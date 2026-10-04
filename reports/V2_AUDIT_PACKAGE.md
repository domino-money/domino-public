# V2 contracts: audit package

This package is for an external reviewer starting cold. It covers:
- what is frozen and how to rebuild it byte for byte;
- what is in scope;
- who can do what;
- every finding, the independent audit's and our own, with its disposition;
- the adversarial suite, and how to rerun it rather than trust it;
- the known limits.

It states limitations as plainly as capabilities.

**This is the remediation candidate.** An independent audit of the frozen `v2-audit-2026-10-04` returned REQUEST_CHANGES: one medium finding, a release blocker, two low and one informational. Its report, findings and evidence are in [`reports/v2-audit-2026-10-04/`](v2-audit-2026-10-04/README.md). Everything it asked for is addressed here; §5 maps each finding to its fix. This candidate is new, never the audited release ([docs/v2/FREEZE.md](../docs/v2/FREEZE.md)). It is tagged `v2-audit-2026-10-04.2`. The auditors' re-audit of it ([`reports/v2-audit-2026-10-04.2/`](v2-audit-2026-10-04.2/README.md)) closed DV2-01, DV2-02, DV2-03 and DV2-05, and left DV2-04's historical record to the documentary disposition in §5.

Process, scope and tags: [docs/v2/FREEZE.md](../docs/v2/FREEZE.md). Design references per front: `docs/v2/F0_INTERFACES.md` … `F4_AUTO_EXIT.md`, `F1_FEES_ROUTE.md`, `F1_POSITIONS.md`, `F1_REGISTRY_ANCHOR.md`, `DEPLOYMENT.md`.

## 1. Freeze

- **This candidate:** the annotated tag `v2-audit-2026-10-04.2` (object `d0c72d80de8037c502401ac9c002c485b8ca89bf`) on commit `559c509ff71d71e49ac720bd6acd8a9783531ebb`, tree `e5ed5db6404ae9d5464028690f788ea3a217ebbd`.
  - The tag was cut after main's own run on that commit, [37223288312](https://github.com/domino-money/domino/actions/runs/37223288312), passed on its first attempt. #323's run 37220671110 passed on the same tree.
  - Manifest: `contracts/release-artifacts-v2.json`, SHA-256 `2975c377c6f3690a702fddeecfe4ffb2c4ccab6e52c8739f4877ce458f66ed5c` (`sourceTreeSha256` `7a78b034fc09c924140173748b5a620cebd539d9635690adbda1154c0b95edfe`).
  - Its record: [`reports/v2-audit-2026-10-04.2/freeze.json`](v2-audit-2026-10-04.2/freeze.json).
- **What changed since the audited freeze:**
  - one source: `route/DominoSwapExecutor.sol` (DV2-01);
  - one release input: `scripts/v2/deploy.mjs` (DV2-05).

  The four contracts that carry the executor grew by 212 B each: DominoAutoExit, DominoV2VaultSwapModule, DominoZapV3 and DominoZapV4. The other eight are byte for byte the audited ones (same creation and runtime hashes in both manifests).
- **The audited freeze, unchanged:**
  - the annotated tag `v2-audit-2026-10-04` (object `ca9aede4ab55de02db39d8714f60abf620515cfb`) on commit `5e63d2dba9123fdc585f7f272b83532b491fbc51`, tree `db8bfb4e57a043a94f7fe55bf02725cb65836b1c`;
  - its manifest's SHA-256: `4f607c2f0ee6c58f156453147fac19029f90b1437613ec3ad228242938436ebb` (`sourceTreeSha256` `296008a420406c857706033149e39d17fba544061507ee9ad0ed06a199f75ad9`);
  - its record, kept as the auditors received it: [`freeze.json`](v2-audit-2026-10-04/freeze.json).

  Main's run on that commit, [37206891445](https://github.com/domino-money/domino/actions/runs/37206891445), failed its first attempt (DV2-02). Its rerun is recorded apart, in [`remediation/main-ci.json`](v2-audit-2026-10-04/remediation/main-ci.json).
- **Trust root:** the manifest pins:
  - the compiler (solc-js `0.8.26+commit.8a97fa7a`, via-IR, 200 runs, `cancun`, `bytecodeHash: none`);
  - the 52 sources;
  - the deployment tool's files;
  - for each of the 12 contracts: creation and runtime hashes and sizes, immutable offsets and ABI hash.

To rebuild and compare, from a clean checkout (DV2-03):

```bash
sh scripts/v2/audit-bootstrap.sh
```

It runs four steps, in order:
1. `npm ci` for the root and `app/`: the pinned Forge and solc-js live in `node_modules`;
2. the seven V1 contracts whose sizes `scripts/test-contracts.mjs` checks after every suite (that gate fails any run without them, V2 suites included);
3. the twelve V2 contracts and `test/v2/integration/IntegrationArtifacts.sol`, the artifacts the wired suites load by name (`vm.getCode`), as CI builds them;
4. `node scripts/v2/release-manifest.mjs --check --forge-out contracts/out`.

- **What the last step proves:** the manifest equals an independent solc-js compile of every V2 source (`deploy.mjs`'s `compileV2`). It also proves that the Foundry artifacts the tests deploy are the same contracts, byte for byte.
- **The deploy binding:** `deploy.mjs` refuses a public preparation from anything else. A deployment manifest's `build.sourceTreeSha256` equals the release manifest's.

| Contract | Runtime | Creation | Immutables |
|---|---:|---:|---:|
| DominoRegistry | 7,091 B | 8,757 B | 0 |
| DominoPriceAnchor | 7,529 B | 8,288 B | 15 |
| DominoAutoExit | 19,922 B | 20,738 B | 21 |
| DominoV2VaultSwapModule | 7,594 B | 8,117 B | 7 |
| DominoV2VaultV3 (clone implementation) | 15,923 B | 37,320 B | 30 |
| DominoV2VaultExecutorV3 | 19,688 B | 20,435 B | 14 |
| DominoV2VaultV4 (clone implementation) | 15,941 B | 41,141 B | 35 |
| DominoV2VaultExecutorV4 | 23,442 B | 24,203 B | 16 |
| DominoV2VaultFactory (one per DEX) | 1,470 B | 2,141 B | 5 |
| DominoZapV3 | 23,766 B | 24,721 B | 15 |
| DominoZapV4 | 21,322 B | 22,230 B | 17 |
| DominoZapV4Steps | 7,394 B | 7,433 B | 1 |

The largest runtime is DominoZapV3's: 810 B under EIP-170's 24,576 B.

## 2. Scope

**In scope: 52 files under `contracts/src/v2`, 8,062 lines.** Lines are counted as `wc -l` counts them; every file ends with a newline. At the audited tag the count was 8,040, as the audit found: this package said 8,039, one short, in the vault's row.

| Module | Files | Lines | What it is |
|---|---:|---:|---|
| `registry/` | 1 | 385 | Roles and lists per chain; 24 h timelock; the guardian narrows only |
| `anchor/` | 2 | 336 | Signed observations or v3 TWAP; band against the live spot |
| `route/` | 5 | 755 | Swap-leg executor (v3 paths, v4 paths, admitted Universal Router), floor, token ops, action lock |
| `fees/` | 2 | 253 | Fee rules (65 bps assisted swap, 2%/4% automation, 20 bps auto-exit) and the owed-fee ledger |
| `positions/` | 13 | 1,899 | v3/v4 position adapters and position math; 10 of the files (997 lines) are Uniswap math vendored from upstream |
| `zap/` | 4 | 794 | S1: create, increase, change range, exit, in one transaction, NFT in the wallet |
| `vault/` | 10 | 1,878 | Automation: clones per owner, the executor (delegatecall), the swap module, plan v1 |
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
| I2 | Owed fees are never spent; only a flush pays them | `FeeNotBacked` after legs (F-01); a hop pays what arrived (F-03); an exact payout measures its debit (F-04); a v3 path's intermediates stay unchanged (DV2-01); `_unowedBalance` | `invariant/ZapLedgerInvariants`, `invariant/ZapV4LedgerInvariants`, `invariant/VaultLedgerInvariants`, `adversarial/HopTokenBacking`, `adversarial/TokenMatrix*`, `route/DominoSwapExecutorV3` |
| I3 | Fee ≤ rate (65 bps, 2%/4%, 20 bps) | FeeRules, executor, auto-exit | `VaultLedgerInvariants` and `WiredVaultInvariants` (per execution), `AutoExitInvariants` (per exit), unit and fuzz suites |
| I4 | Swap floors from the anchor | vault, auto-exit; the zap uses the user's signed minimums | `HostileOperator`, `AutoExitAttacks`, `AutoExitInvariants`, journeys |
| I5 | Exact input per leg; every other token a leg moves in the host, a v3 path's intermediates included, unchanged; no allowance survives | SwapExecutor effect checks | `ZapLedgerInvariants`, `ZapV4LedgerInvariants`, `TokenMatrixZapInvariants`, router suites, `route/DominoSwapExecutorV3` |
| I6 | Only the owner withdraws; funds go only to the owner, the module or the named recipient | onlyOwner, returnReserves | `VaultLedgerInvariants`, `WiredVaultInvariants`, Owner/Return/Exit suites |
| I8 | Auto-exit fires only across the anchor, inside the band, once, on an enabled vault and its owner | AutoExit, executor | `adversarial/AutoExitInvariants`, `AutoExitAttacks`, `AutoExitVaultAttacks`, auto-exit unit suites |
| I9 | Anchor freshness, signer, epoch, TWAP window (600 s to 1 h), band | Anchor, AutoExit | anchor suites, `AutoExitInvariants`, `AutoExitAttacks`, `RegistryInvariants` |
| I10 | The vault touches only the armed, live root; owner changes disarm | executor, V3/V4 | Custody suites |
| I12 | The state nonce only grows | storage | `VaultLedgerInvariants`, `WiredVaultInvariants` |
| I13 | Registry: timelock, readmission rules, disjoint roles, epoch only grows | Registry | `adversarial/RegistryInvariants`, `RegistryAttacks`, `WiredRegistryAttacks` |
| I15 | One action lock; callbacks authenticated | ActionLock, SwapExecutor | route suites, `ZapLedgerInvariants` (router re-entry), journeys |
| I16 | Auto-exit: balance(T) ≥ owed(T) + unclaimed credits(T) | AutoExit, executor (DV2-01) | `adversarial/AutoExitInvariants`, `AutoExitAttacks` |

## 5. Findings

### The independent audit of `v2-audit-2026-10-04`

The audit's own words are in [`AUDITORIA_DOMINO_V2.md`](v2-audit-2026-10-04/AUDITORIA_DOMINO_V2.md) and [`FINDINGS.json`](v2-audit-2026-10-04/FINDINGS.json).

| ID | Severity (audit) | What | Disposition |
|---|---|---|---|
| DV2-01 | Medium | A direct v3 multi-hop leg checked the leg's two ends and the action's tokens, not the path's intermediate tokens. A hop token that debits its sender more than it moves could spend what the host already held in it: owed fees (zap), recoverable tokens (vault), deferred deliveries (auto-exit) | Fixed: every intermediate of a v3 path is tracked like the action's own tokens, so its balance must be unchanged after the leg, or the leg reverts (`SwapEffectMismatch`). The intermediates are read only from a well-formed path. Regressions on each host: `route/DominoSwapExecutorV3` (an over-debiting intermediate; the third token of a four-hop path; malformed paths), the zap (`HopTokenBacking`), the vault (`HostileOperator` V3), the auto-exit (`AutoExitAttacks`, a deferred delivery). The other leg kinds never hold an intermediate in the host: the Universal Router pulls only the leg's input through Permit2, and v4 nets hops inside the PoolManager. V2 is not deployed on any public chain (only the fork rehearsal of 2 Oct), so no asset was exposed |
| DV2-02 | Release blocker | Main's run on the frozen commit failed in the deploy tool's tests (3 of 53) | Root cause: a test left a transaction pending in Anvil, `evm_revert` does not clear the pool, and the transaction spent the next test's nonce. Fixed in the tests: every isolated test drops pending transactions, and a regression test proves none outlives its test. The audited run is recorded as it happened (`remediation/main-ci.json`); this candidate is tagged only after its own main run passes |
| DV2-03 | Low | The cold instructions built neither the integration artifacts nor the V1 contracts the runner's size gate reads, so no behavioural test could run | `scripts/v2/audit-bootstrap.sh` (§1), run on a fresh checkout of this candidate |
| DV2-04 | Low | The package's mutation claims (29 of 29, 18 of 18, 5 of 5) had no committed inputs or results, and eight vault mutants no longer applied | The three campaigns are committed batches, transcribed from their scripts, rerun on this candidate (§6). The eight vault mutants are rewritten, and two added for the guards #317 introduced. A run's report names the batch, every source and every suite by SHA-256. **Disposition after the re-audit (4 Oct):** the 3 Oct runs bound to no source hash, and nothing can bind them now. This package withdraws them as evidence, with no retroactive claim; their records stay as history. The evidence from here on is the candidate's reruns. Those are the author's runs, not the auditors': anyone can repeat them with the committed batches and runner |
| DV2-05 | Informational | The deploy tool read an RPC reply of any size and did not check that it answered its request | A reply is read up to 8 MiB (`rpc_reply_too_large`). It must be a JSON-RPC 2.0 object with the request's id and exactly one of `result` or `error`; a null id is accepted only on an error (`rpc_invalid_reply`). The time and call limits are unchanged |

The audit also asked for four limits to be stated plainly: B's scope, the v3 rearm, the cost of `exitAll` and the line count. They are in §5's table below, §7 and §2.

### Raised internally

| ID | Severity (ours) | What | Disposition |
|---|---|---|---|
| F-01 | High | A zap leg could spend fees the zap owes, in a token outside the action's own | Fixed (#317): after the legs, every leg input must still back what is owed in it |
| F-02 | High | A Universal Router leg could carry position-manager commands, which the router authorises by its caller (a Domino contract) | Fixed (#317): router legs accept only swap, payment, Permit2-pull, wrap and balance-check commands |
| F-03 | Medium | A direct v3 multi-hop leg paid each hop the pool's reported output, so a buy-taxed hop token was made up from the contract's own balance (owed fees in the zap, recoverable tokens in the vault, deferred deliveries in the auto-exit) | Fixed (#319): each hop pays forward what arrived. Regressions: `HopTokenBacking`, `HostileOperator` V3 |
| F-04 | Low | The zap's refund and the vault's exact payouts (`withdrawReserves`, `recoverToken`, the exit module's delivery) read nothing back, so a token that debits its sender more than the amount spent fees owed in it (and, in the vault, other reserves in it) | Fixed (#319): each exact payment measures its own debit and refuses one that took more than it moved (`TokenCallFailed`). The best-effort sweeps keep A8 (§7) |
| B | Known limit | A double-entry token (two addresses moving one balance): the contracts keep what they hold per token address, so what they keep in that token can be refunded or recovered through its twin | Such tokens are outside the model and not supported. The owner accepted this on 4 Oct as "only that token's fees are exposed". The audit found that too narrow for the auto-exit, where the owners' `unclaimed` credits in that token are also kept per address. Restated: everything kept per address in that token is exposed: owed fees (zap, vault, auto-exit) and the auto-exit's credits. That reach was found by reading the code; no supported token shows it. The owner confirmed the restated scope on 4 Oct. Pinned by `testKnownLimit_*` in `TokenMatrixZap` and `TokenMatrixVault` |
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
| `adversarial/HopTokenBacking` | 4 | F-03 and DV2-01 on the zap |
| `adversarial/HostileOperator` | 5 + 3 | The operator's bounds on the wired world: the floor to the unit, an observation at the band's edge, a pause never holds the owner's money; F-03 and DV2-01 on the vault (v3) |
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
| `adversarial/AutoExitAttacks` | 26 | The TWAP window's bounds (D-1), stale and replayed observations, a publisher rotation, the halt, hostile routes, a vault no factory made, consent, front-running a revoke; DV2-01 on a deferred delivery |
| `adversarial/AutoExitVaultAttacks` | 5 × 2 | On the real vault (v3 and v4): an exit while paused, `exitAll` disabling the module (D-2), the halt at the module and at the vault |

**Mutation.** Every batch is committed under `contracts/mutations/` and run with `scripts/mutate-contracts.mjs`. A guard counts only when deleting or weakening it fails a test. An edit that does not apply or does not build fails the batch. The runs on this candidate are in `reports/v2-audit-2026-10-04/remediation/mutations/`. Each report names the batch, every source and every suite by SHA-256, and each source's hash equals this candidate's manifest entry.

| Batch | Mutations run | Caught | What |
|---|---:|---:|---|
| `v2-auto-exit-adversarial-2026-10-03.json` | 29 | 29 | The edits behind this package's former "29 of 29": the module's guards against `AutoExitInvariants`, `AutoExitAttacks` and `AutoExitVaultAttacks`, the module rebuilt per mutant |
| `v2-registry-adversarial-2026-10-03.json` | 18 | 18 | The former "18 of 18": the registry's guards against `RegistryInvariants`, the registry rebuilt per mutant |
| `v2-audit-2026-10-04.json` | 10 | 10 | The former "5 of 5" (D-1 and D-2, same text), DV2-01's tracking and each of its path checks |
| `v2-vault-2026-10-02.json`, `--only` | 10 of 194 | 10 | The eight edits the audit found stale, rewritten, and the two guards #317 added |
| `v2-fees-route-2026-10-01.json`, in three `--only` parts | 117 | 117 | Every guard of the fee module and the swap-leg executor (F1, #283). In part 3, "one measured amount per leg" did not build: deleting its check overflows the via-IR stack in its suite's unit. It now keeps the comparison behind a bound no memory array reaches, so the check never fires, and its rerun alone (`part-3-rerun`) caught it. Parts 1–3 ran the batch at `fbbc4a6b…`; the rerun ran it with that one revision, at `600e5ba8…` |

The three former claims rested on hand-run scripts of 3 Oct, on working trees nobody hashed. They are withdrawn as evidence (re-audit of 4 Oct); `remediation/mutation-history.json` keeps their results as recorded then, as history only. The reruns above are the evidence. They are the author's runs; the auditors re-ran none. Anyone can repeat them with the committed batches and runner. The other committed batches (positions, zap, integration, registry and anchor, `returnReserves`, the auto-exit's unit batch, the rest of the vault's) all apply to this candidate's sources. Their results are not recorded in the repository: run them.

**How to run:** one suite at a time, after the bootstrap (§1; a whole-tree run exhausts solc-js memory):

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

The audit of 4 Oct found B's wording too narrow; the owner confirmed B's restated scope the same day (§5). The audit also asked for the v3 rearm and the cost of `exitAll` to be stated plainly; both are below.

- **No fork tests in CI** (no network). The suites etch the bytecode deployed on Base and Robinhood instead (`positions/fixtures`, `route/fixtures`). The fork rehearsal of 2 Oct deployed the configuration on forks of the three chains (`docs/deployments/v2-rehearsal-2026-10-02`).
- **No symbolic execution and no formal proof.** The independent audit ran Slither (352 results, none confirmed) and a manual review, which found DV2-01.
- **Hostile tokens:**
  - A token that debits its sender more than it moves can still spend fees owed in itself through the best-effort sweeps (`exitAll`, `returnReserves`, `_release`). A8 keeps them from reverting over one token, so they do not refuse it. Accepted and pinned.
  - A double-entry token (B): everything kept per address in that token is exposed, the auto-exit's credits included (§5).
  - A transfer that reports success without moving, one that moves but returns false, a lying `balanceOf`, an additive `approve` and a negative rebase are pinned as accepted or informational behaviours.
- **The v3 operator rearm compares two checkpoints** (accepted with the rearm, 2 Oct). It cannot prove that every step between them was an addition. An owner's decrease whose principal fits in the slack passes as fees, and the vault charges its tariff on it. The slack is at most `g × (current − previous liquidity)` per token, with `g` the fee growth since the checkpoint. It has no small absolute ceiling: it grows with the liquidity added and with the fee growth. Details: [F3_VAULT.md](../docs/v2/F3_VAULT.md), "What the check cannot see".
- **`exitAll` gas grows with members and with the tokens' behaviour.** There is no capacity certificate for any chain or configuration: the figures here are measured in the test world. The ladder fits at most about 216 members before MAX_TICK. Both pool tokens burning gas take `exitAll` to 28–32M gas, past a 16.7M per-transaction cap (ReturnBomb). The per-position path is part of the runbook, not a fallback to improvise: pause, disable the exit module, `withdrawChild` one by one, `withdrawReserves` per token ([F3_VAULT.md](../docs/v2/F3_VAULT.md), "When `exitAll` does not fit a transaction"). `ReturnBomb` runs `withdrawChild` on 500k gas and `pause` on 200k with both tokens burning.
- **The auto-exit's anchor can sit at the band's edge.** The operator chooses the evidence within the mandate's band, so the floor stacks on the band: with a 1% mandate on a 0.3% pool, the owner's token sells at 97.8% of its spot value instead of 98.7%. This is accepted by F4 (the floor is against the anchor) and pinned by `testAnAnchorAtTheBandsEdgeStacksTheBandOnTheFloor`.
- **The auto-exit fee follows the registry's ranks at execution.** No mandate signs it.
- **Operator trust is bounded, not removed:** see §3.
