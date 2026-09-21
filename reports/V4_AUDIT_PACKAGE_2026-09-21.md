# V4 contracts: audit package — 21 September 2026

What an external reviewer needs in order to start: what is frozen and how to rebuild it byte for
byte, what is in scope and what is deliberately not, who can do what to a live vault and what
each of those keys can cost if it is lost, every finding raised internally with its disposition,
and how to check the coverage claims instead of trusting them.

This document is written to be read by someone with no other context. It states limitations as
plainly as capabilities; where a claim rests on a measurement, the measurement is named.

## 1. Freeze

**Corrected production-source freeze: `aaf33947e7aeccf902b311c6d2282a742a929c2b`.**
This supersedes the original `ec2e9aa` freeze after the executed audit found a
Nitro block-domain incompatibility and coupled Setup refunds. The corrected
contracts use the qualified ArbSys L2 number/hash source and provide independent
owner currency recovery. See [remediation evidence](v4-remediation-2026-09-21/)
and the [historical audit findings](V4_AUDIT_EXECUTION_2026-09-21.md).
The deployment package must name the full final checkout SHA; its artifact
loader verifies every source hash against that checkout.

Build profile, enforced on every artifact by `scripts/check-contract-size.mjs` (it refuses an
artifact built any other way, which is how a stale `out/` is caught):

| setting | value |
| --- | --- |
| compiler | `solc 0.8.26+commit.8a97fa7a`, invoked through `scripts/solc-wrapper.py`, offline |
| EVM version | `cancun` (the vault and engine use EIP-1153 transient storage) |
| optimizer | enabled, 200 runs, `via_ir = true` |
| metadata | `bytecode_hash = "none"` |
| limits | EIP-170 runtime 24,576 B; EIP-3860 initcode 49,152 B, constructor arguments included |

The seven deployed artifacts, in deployment order, with the runtime `keccak256` of each. These
are what `prepare-financial-release.mjs verify` compares against the chain after deployment,
outside the immutable slots:

| # | artifact | runtime | runtime keccak256 |
| ---: | --- | ---: | --- |
| 1 | `DominoVaultFactoryV4` | 3,502 B | `0xd5d36d4ea4be9009f451fdd5801b19d4ed8b75b1acafd786f6102eff71246f55` |
| 2 | `DominoVaultReadHelper` | 6,858 B | `0x246fe0cd81ae92cd3a0758389fb3de4302bca6050fbd866941a53c8c24cbcc36` |
| 3 | `DominoRoutingHelperV4` | 13,873 B | `0xd3c0d439931fd9ea2bb54016231eab44ba99196b82b58d6076322a40facee9b8` |
| 4 | `DominoPriceGuardV4` | 3,516 B | `0x6a5d9ceca64f252ab246a9b8e74c80eb20d149b3e8e4f6cbcddbb0cff0112885` |
| 5 | `DominoExecutionEngineV4` | 21,899 B | `0x22e3b9f9fe254f59aa969e6bf33b1e69655b8bd376fd8e7a8d4207d1ad542416` |
| 6 | `DominoVaultV4 (clone implementation)` | 23,625 B | `0x8c4cfc9d27602ec81d64e0d5e2d0c186fef65c69b45579ff81babb58bc01fc09` |
| 7 | `DominoSetup` | 13,239 B | `0x6060c68a9f15c5c22949ac060554bed17656290f707a0dbb16061d8a015812a6` |

An eighth transaction, `factory.finalizeImplementation(implementation)`, binds #6 to #1 once and
for ever. User vaults are EIP-1167 clones of #6; the clone's runtime is fixed bytecode and its
hash is recomputed independently by the release verifier.

Rebuild each suite separately and confirm (the loop in §6 avoids a whole-tree compiler memory spike):

```bash
npm ci
# Run the sequential suite loop in §6, then:
node scripts/check-contract-size.mjs
```

**Pinned chain dependencies, not deployed by this release** (Robinhood Chain, chain id 4663;
`backend/discovery.py` and `scripts/prepare-financial-release.mjs` hold them, and the verifier
compares their runtime hashes with explicit `dependencyCodeHashes` inputs and checks their links to the pool manager at the finalized block):
PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`, PositionManager
`0x58daec3116aae6d93017baaea7749052e8a04fa7`, StateView
`0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`.

## 2. Scope

**In scope — 13 files under `contracts/src`, 2,630 lines**: the seven artifacts above,
plus `DominoVaultTypes.sol`, `DominoExecutionTypes.sol`, `IDominoVaultDraft.sol` (the interface
the vault takes its `Policy` struct and events from), `PolicyValidation.sol` and
`FeeAccounting.sol`, plus the new `DominoL2Block.sol`. `DominoRoutingHelperV4` is the only production source that imports the
vendored Uniswap tree, for `FullMath` and `TickMath`.

**Vendored, in scope as a dependency but not as authored code**: Uniswap v4 core and periphery,
solmate, permit2 and OpenZeppelin under `contracts/test/reference/official-v4/`. They are authentic
upstream sources used by local reference tests, but are not byte-for-byte the
verified deployed source builds. Forks execute the actual upstream chain code.
The [independent runtime qualification](v4-remediation-2026-09-21/DEPENDENCY_QUALIFICATION.md)
records the exact expected deployed dependency hashes and source-provenance limits.

**Out of scope, and why.** The backend (planner, signer, durable executor, read path), the
frontend, the Cloudflare workers and the `api-contracts` wire packages: a different review.
The signer and executor have never run against a real deployment; that is stated in §4 as a
known limitation, not hidden. The V3 lineage (`DominoVault`, `DominoVaultFactory`,
`DominoCompoundEngine`) was retired on 20 September and is not in the tree; it was never
publicly deployed.

**Deployment and activation are separate acts.** This package covers the contracts. Nothing here
authorizes the operator or publisher services, whose profiles are issued after the release is
verified.

## 3. Trust model

Six roles. None of them can take a position or a reserve out of a vault except the owner.

| role | set when | what it can do | what it cannot do |
| --- | --- | --- | --- |
| **deployer** | deploys the factory | call `finalizeImplementation` exactly once | anything afterwards: there is no upgrade, no second finalization, no admin key |
| **owner** | vault creation, immutably bound to one address | policy and execution limits, set and revoke the operator, pause and resume, re-arm the root, withdraw child positions, withdraw fee reserves, recover untracked currency and unmanaged NFTs | nothing is withheld from the owner; every exit works with the engine, the operator, the publisher and even the read helper unavailable (`DominoVaultV4Architecture.t.sol:281`) |
| **operator** | set by the owner, revocable at any time | `execute` one price-anchored plan at a time, and `pause` | resume, change policy or limits, withdraw anything, move a position |
| **price publisher** | constructor argument, rotatable (below) | publish reusable pool observations and revoke observations | publish outside the deviation band around the pool's live reading; nothing else on any vault |
| **price guard guardian** | constructor argument, immutable | propose the next publisher (which must accept), and revoke any observation | widen the band or directly control a vault; it can gain publishing authority through rotation |
| **service fee recipient** | constructor argument, immutable | receive the service fee the policy sets (`FeeAccounting.MAX_SERVICE_FEE_BPS` caps it at 200 bps) | initiate anything |

**What a compromised key costs.**

- *Operator.* Every action needs a published observation and remains subject to owner
  limits and swap slippage checks. The plan's add ceiling constrains that submitted plan;
  it is supplied by the operator, so it is not an independent bound against the same
  operator choosing a broader ceiling. Pre-observation manipulation remains possible.
  The [corrected fork report](EXECUTION_FORK_SANDWICH_2026-09-20.md) compares each
  recipe with its corresponding honest control and marks absent swap outputs unavailable.
  Point samples do not establish a $500 per-vault safety threshold. Multiple vaults can
  sell against one moved pool before restoration, sharing the attacker's manipulation
  cost. Evaluate aggregate exposure across that pool/window; no on-chain aggregate
  exposure cap or universal economic safety bound is demonstrated here.
- *Publisher.* A liveness dependency: every action needs an observation, so a silent publisher
  stops automation. Owner exits are unaffected. A stolen key cannot publish a price outside the
  band around the pool's own reading, and the guardian can revoke an observation without the
  publisher key. This is the deliberate residual: **one live publisher, no threshold.**
- *Guardian.* Can nominate itself or another address it controls as publisher, then
  accept as that address. It has indirect publishing authority, no direct vault control
  and no power to widen the immutable band. The honest backend requires publisher
  profile re-admission after rotation; this does not restrain a compromised operator
  submitting transactions directly.
- *Owner.* Total, by design. The owner is the position's owner.

**Rotating the publisher** is a two-call acceptance procedure needing no redeployment:
`guardian.proposePublisher(next)`, then `next.acceptPublisher()`. Observations the old key
published remain readable until revoked or expired — at most 255 L2 blocks. The old publisher need not approve the change, and independent key custody is not enforced. The procedure and the
re-admission that must follow are in [FINANCIAL_RELEASE](../docs/FINANCIAL_RELEASE.md).

**Initial address separation, enforced by the release tooling before transaction preparation**: operator ≠
publisher; guardian ≠ publisher and ≠ operator; none of them is the fee recipient or any
deployed component. The verifier requires no runtime code for deployer, operator, publisher and guardian at the
verified finalized block.

## 4. Known limitations

Stated here so nobody has to find them.

1. **One live publisher is a liveness dependency.** No threshold, no fallback oracle. Chosen
   over adding a new trust role; rotation is the mitigation.
2. **Pre-observation manipulation is outside what any on-chain band can see**, since the
   published price and the spot agree. Bounded by the publisher's integrity and by the
   attacker's cost, both measured above.
3. **A concentrated position fails closed on small moves.** On a ±2% range, a 0.5% move between
   observation and execution changes the required composition beyond an honestly sized plan and
   the compound reverts with `InvalidAmount()`. Safe, but the executor must re-plan rather than
   treat it as a fault — and that executor behaviour is not yet tested.
4. **Findings D-05 … D-08 were never recorded.** The internal review cites D-09 and D-10 by
   number and never enumerates what lies between; those four cannot be recovered. Everything
   else on record has a disposition in §5.
5. **`NET` and `FUND` have not run on a real forked pool.** Both run against the vendored
   official contracts in local fixtures; `GENERAL`, the swap path and `MINT` ran on the real
   `weth-usdg` pool.
6. **The economic figures are point samples.** The fork's fees came from synthetic volume, and
   the gas figures are one block's readings (1,162,908 L2 gas for a 1,764-byte compound; the L1
   data component read as zero from the live node's `NodeInterface`). The real fee-accrual rate
   of any pool is not measured.
7. **The service around the contracts is unproven.** Signer, executor, planner and read path
   have never run against a real deployment.

**Gas funding.** The operator's previously funded native ETH pays automated
execution gas; the publisher separately pays for observations. The owner pays
setup and manual transactions. The simulator grants synthetic ETH using
`anvil_setBalance`. The 2% cut on consumed earned fees goes to the immutable fee
recipient in the consumed currency. No automatic sale or top-up replenishes the
operator; an insufficient native balance makes the signer refuse execution.

**Owner recovery.** Setup now exposes `recoverCurrency` and `recoveryStarted`
without changing the existing operation tuple. A successful partial recovery
permanently disables swap/mint, preserves other outstanding claims and charges
no Domino exit fee. Restricted-token transfers may remain blocked by that issuer;
the healthy counterasset can be recovered independently. Recovery enforces the
exact escrow debit and records actual owner balance observations, including
recipient taxes. See [owner recovery](../docs/OWNER_SETUP_AND_RECOVERY.md).

## 5. Index of findings

Three internal reports. Every finding on record, with what closed it.

| report | what it covers |
| --- | --- |
| [CONTRACT_REVIEW_2026-09-19](CONTRACT_REVIEW_2026-09-19.md) | the standing review: hardening (D), optimization (F/V), the two false records, what was verified sound, what was not covered |
| [CONTRACT_HYGIENE_2026-09-19](CONTRACT_HYGIENE_2026-09-19.md) | H-01 and H-02, the two false records and the untested shipping vault |
| [CONTRACT_HYGIENE_MINOR_2026-09-19](CONTRACT_HYGIENE_MINOR_2026-09-19.md) | M-03 … M-22, the minor findings re-derived, and the seal |
| [EXECUTION_FORK_SANDWICH_2026-09-20](EXECUTION_FORK_SANDWICH_2026-09-20.md) | D-01 and D-02 reproduced by execution on the real pool; the lifecycle and the gas readings |
| [V4_AUDIT_READINESS_2026-09-20](V4_AUDIT_READINESS_2026-09-20.md) | the four tracks and their seals, which this package supersedes as the entry point |

**Hardening.** D-01 (every action anchors to a published price, bounded against the pool's live
reading) — fixed in `28eeaa9`, reproduced on the real pool. D-02 (a plan states the ceiling of
one add) — fixed, and the ceiling was shown deciding on a wide range. D-03/D-04 (the publisher
was one immutable key with no on-chain sanity check) — the band in `28eeaa9`, guardian rotation
in `ec2e9aa`. D-09 (the overflow threshold of the routing arithmetic) — measured, not estimated:
`DominoRoutingArithmetic.t.sol`. D-10 (per-execution scratch to transient storage) — done, and
it is what bought the room for D-01 and D-02. D-05 … D-08: never recorded (§4.4).

**Optimization.** F2 and F7 taken (−9.2% on a general execution, −11.1% on a netting one). F3
declined, premise false. F11 declined: 91 B is not worth removing a defence-in-depth codehash
check. V2 declined: 2,182 B measured, but the optimizer sequence that yields it fails to compile
the tree. Compaction items V1 and V4–V8 became unnecessary once D-10 freed the room.

**Hygiene.** H-01, H-02 and M-03 … M-22 all closed; three of them (M-19, M-20, and the nine
clauses listed in the price guard's suite) are *recorded redundancies* rather than removals —
correct, cheap, and load-bearing again if a neighbouring check were relaxed. M-21 and M-22 were
found while closing the others: a test of mine that claimed a clause it could not reach, and
`resume()`'s permission check, which no suite in the tree covered.

**Two checks keep the closed tracks closed**, both in CI: `scripts/check-contract-hygiene.mjs`
(licence, one pragma, no leftover markers, no unused or development-only imports) and
`scripts/gas-baseline.mjs --check` against the committed `contracts/.gas-snapshot`.

## 6. Reproducing the evidence

**The suites.** **20 suites, 256 tests passed, none failed or skipped.** Results are recorded in [suite-results.json](v4-remediation-2026-09-21/suite-results.json). The original audit had 15 suites and 228 tests; corrected-source regression suites extend that evidence. A single Forge invocation over the whole tree exhausts
memory (issue #145), so each suite is run against its own dependency closure, as CI does:

```bash
for suite in $(find contracts/test -name '*.t.sol' | sort); do
  node scripts/test-contracts.mjs --match-path "${suite#contracts/}"
done
```

**Targeted guard coverage is checked by mutation, not inferred from test counts.** A guard counts as covered when
deleting it makes a test fail. `scripts/mutate-contracts.mjs` runs the committed targeted batches. The historical
claims whose inputs are absent cannot be reproduced exactly:

```bash
node scripts/mutate-contracts.mjs batch.json   # --head to mutate the last commit instead of the tree
```

A batch is JSON — a suite, a file, and mutations each naming the text to delete or replace. It
copies the repository to a temporary directory and mutates only the copy; the working tree is
never touched, because an earlier run left a mutated security guard in the tree and it reached a
full backend run before it was caught. A mutation that does not apply is reported as an error,
never as a pass. The verdicts are `CAUGHT`, `NOT CAUGHT`, `NOT APPLIED` and `NO BUILD`.

The historical 39-clause price-guard and 15-clause arithmetic batch JSON inputs
were not committed and their exact coverage totals were not reproduced. They
are historical assertions, not current reproducible coverage. The two newly committed batches contain eight named mutations; **8/8 were caught**.
Their [actual verdicts](v4-remediation-2026-09-21/mutation-results.json) and exact
[batch inputs](../contracts/mutations/) are committed;
`NOT APPLIED` and `NO BUILD` never count as caught guards. A passing baseline and
explicit expected verdicts are required; unexpected results fail the command.

**The fork qualification.** `backend/qualify_execution_fork.py` forks chain 4663 at the head of a
node, deploys the stack from the built artifacts, gives a synthetic owner a real root position
in `weth-usdg` through `DominoSetup`, earns it fees against the real pool, and runs one compound
per scenario from one snapshot. It accepts the official public RPC with `--public-rpc`, or an explicit qualified
read gateway/loopback source. Local runs install an ArbSys stand-in and record
that emulation; only the separate live probe qualifies Nitro block semantics:

```bash
backend/.venv/bin/python backend/qualify_execution_fork.py \
  --public-rpc --rounds 40 --moves 50,90,110,500,2000 \
  --lifecycle --output /tmp/fork.json
```

A pruned node keeps state only for its block-age window, so the run starts at the head and must
finish inside it; each of the recorded runs took about four minutes. Raw outputs are in
[`fork/`](fork/).

**The invariants.** `contracts/test/DominoVaultV4Invariants.t.sol` drives a fuzzed owner and
engine over one vault — credits, converted credits, withdrawals, donations, untracked recovery,
successor mints through the real `executionMint`, child exits — under five invariants: the
currency ledger is the sum of its sources; every tracked unit is backed by balance;
`activePositions` counts the active members; the state nonce only grows; a withdrawn child never
comes back. A scripted self-test proves each handler action reaches the vault, so a run that
only ever reverted cannot pass quietly.

**Deployment tooling.** `node scripts/prepare-financial-release.mjs prepare|verify` produces the
eight unsigned transactions and verifies a completed deployment against the same pinned
artifacts. It reads no key, signs nothing and submits nothing. The procedure, its inputs and its
partial-failure rules are in [FINANCIAL_RELEASE](../docs/FINANCIAL_RELEASE.md).

## 7. What would most repay an auditor's time

Offered as the authors' own reading of where the risk is, not as a limit on scope.

1. **`DominoExecutionEngineV4.unlockCallback` and the fee-accounting path.** The engine holds the
   pool manager's unlock for one plan; every budget, allocation and settlement happens inside it.
   The conservation arithmetic was verified internally on both the netted and non-netted
   branches, and it is the densest code in the tree.
2. **The anchor's sufficiency.** §3 states what a compromised operator can and cannot do; the
   pre-observation residual is the part we can bound only economically.
3. **The transient-storage discipline.** The vault and engine keep per-execution state in
   EIP-1153 slots, discarded at the end of the transaction rather than the call. The callback
   guards depend on that distinction.
4. **The custody edges**: re-arm, unsubscribe during an owner exit, terminal nonce and generation
   values, and recovery of an NFT the vault never registered. These are where a vault could
   strand a position, and where the owner's guarantee in §3 would fail if it failed anywhere.
