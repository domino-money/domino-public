# Public Domino V1 contracts — technical implementation V4

The public release contains seven contracts: the owner-bound immutable `DominoVaultV1`
clone implementation, its `DominoVaultFactoryV1`, the non-custodial
`DominoExecutionEngineV1`, `DominoRoutingHelperV1`, `DominoPriceGuardV1`, the
stateless `DominoVaultReadHelperV1`, and owner-funded `DominoSetupV1`. The factory
deployer finalizes the implementation once; it has no upgrade path. Each vault
pins its engine and read helper, and its owner individually authorizes an operator.

These public entrypoints inherit the existing technical V4 or unversioned bases
without new operational functions, storage or overrides. The vault still returns
`implementationVersion() == 4`; execution adapters, plan domains and schemas keep
their technical versions. Uniswap V4 is independent of the public Domino V1 name.
The public builder verifies exact creation/runtime bytecode, ABI and immutable-range
equivalence to the bases before release preparation.

The independent-audit baseline is tag **`v4-audit-2026-09-21`**, full checkout
`255fc38b6eb62d630c8354a8dcec870f3c9dee39`, frozen after all CI jobs passed.
Start with the [independent audit specification and complete suite](../reports/V4_INDEPENDENT_AUDIT_SPEC_2026-09-21.md),
the [corrected audit package](../reports/V4_AUDIT_PACKAGE_2026-09-21.md)
and [21 September remediation evidence](../reports/V4_REMEDIATION_2026-09-21.md).
That frozen baseline is historical. The [M1/M2/M3 candidate](../reports/V4_M123_REMEDIATION_2026-09-21.md)
and subsequent public V1 entrypoints are separately identified changes; the
original audit tag is not a claim that it includes those later changes.
The [execution specification](V4_EXECUTION.md) describes the typed wire,
accounting and limits. No production signer or user deployment is enabled by
passing local tests.

## Execution, fees and setup

V4 implements typed GENERAL, NET, FUND and MINT actions: self-compound, bounded
same-pool fee balancing, successor creation and successor funding. Plans bind
authority, nonce, deadline, source budgets and price observations. The engine
measures realized fees, preserves principal and rejects unconsumed exact
allocations, unpaid AMM debt and failed postconditions atomically. It cannot
choose an arbitrary router, recipient or wallet debit.

`FeeAccounting.sol` supplies the per-currency split. The engine preserves source
lineage through swaps and charges 200 bps in simple mode or 400 bps in Domino
mode on consumed original earned fees, once. The rate follows the selected mode
for every recipe, including same-position reinvestment in Domino mode. Unspent fees and already-charged output are not charged again.
Integer floor rounding favors the owner: at 200 bps, 49 base units incur zero
and 50 incur one; at 400 bps, 24 incur zero and 25 incur one. This arithmetic is not a profitability threshold; the planner
still needs qualified costs, price inputs and an economically eligible action.
See [reinvestment policy](../REINVESTMENT_POLICY.md) and
[pricing policy](../PRICING_POLICY.md).

`DominoSetupV1`, inheriting `DominoSetup`, separately implements owner-funded bounded swaps, position minting,
and pool initialization plus first mint. Its optional assisted-swap tariff is
capped at 65 bps and does not apply to automated internal swaps. The owner can
cancel normally or recover either escrow currency independently. Starting
independent recovery permanently disables swap/mint for that operation while
preserving the remaining claim; recovery has no service fee. Restrictions on
the selected token itself can still prevent its transfer. See
[owner setup and recovery](../docs/OWNER_SETUP_AND_RECOVERY.md).

On Robinhood Chain 4663, price observations and vault checkpoints use
`DominoL2Block` to obtain the L2 block number/hash from ArbSys. The shared recent
window is 255 L2 blocks. Invalid replies fail without falling back to native
`NUMBER`/`BLOCKHASH`, which have different Nitro semantics. Local Anvil fixtures
explicitly emulate ArbSys; the separate live read-only probe tests the actual
chain behavior.

Automated transactions require prefunded native ETH in the operator wallet;
the publisher funds its own observations. There is no automatic sale of user
assets, gas reimbursement or wallet top-up. Service revenue reaches the fixed
recipient in the consumed currency. [Gas funding](V4_EXECUTION.md#who-pays-gas-and-how-the-operator-is-funded)
describes the signer check and synthetic fork funding.

## Owner policy and authority

V4 calls `PolicyValidation.validateInitial(policy, 1)` for atomic root-only
initialization and validates policy updates against its actual active membership.
The validator chooses no default policy. `IDominoVaultDraft.sol` provides the
shared policy struct and events; it is not the V4 ABI.

| Field | Enforced domain and meaning |
| --- | --- |
| `serviceFeeBps` | Exactly 200 for simple root-only compound, or 400 for Domino; this is the canonical mode discriminator without changing the Policy ABI |
| `triggerDistanceBps` | 0–2000 inclusive, independent from overlap |
| `maxOverlapBps` | 0–2000 inclusive, independent from trigger distance |
| `minimumIntervalSeconds` | 1–4,294,967,295 inclusive |
| `maxPositions` | Simple: exactly 1. Domino: 1–255, counting root plus active children; cannot fall below actual membership |
| `version` | 1 initially, then exactly current + 1; overflow is rejected |
| `paused` | Explicit initial state; policy writes preserve it, dedicated calls change it |

Simple mode rejects successor actions and another position’s fee sources. A mode
change is an owner policy transaction; it never recharges already charged lots.
Downgrading requires withdrawal of active children, preserving owner access to
their unused fee reserves.

Type ceilings are representational bounds, not approved resource or operational
limits. Fixture policy values do not establish production defaults.

| Call | Required caller |
| --- | --- |
| Read getters | Anyone |
| `execute` | Owner or current operator, while unpaused and subject to all authority, subscription and execution checks |
| `setPolicy`, `setExecutionLimits`, `setOperator`, `resume`, `rearmRoot` | Owner only |
| `pause` | Owner or current operator |
| Reserve, child-NFT and untracked-asset recovery | Owner only, including while paused; fixed owner recipient and no exit toll |

Policy, authority and membership changes invalidate prior plans through the
state nonce and relevant generation. At terminal counter values, new authority
is prohibited while owner recovery remains possible without wrap. Saturated
counters stay saturated and `TerminalRecovery` identifies the exception.
Historical source records preserve claims after a child leaves active membership.
The root NFT stays in the owner's wallet under individual approval; successors
mint to the vault. Recovery does not require an online operator or engine.

## Evidence and local verification

The V3 `compoundSelf` implementation was retired on 20 September 2026 without
public deployment. Its custody regressions now run against V4; the
[E2](../docs/PUBLIC_VAULT_E2.md) and [V3](../docs/PUBLIC_VAULT_V3_COMPOUND.md)
documents remain historical. V4 has no manual `adoptChild` entry point.

Official-v4 tests execute actual vendored PoolManager and PositionManager
implementations. Their upstream provenance and licenses are preserved; those
reference builds are not byte-identical to the verified mainnet dependency
builds. [Independent dependency qualification](../reports/v4-remediation-2026-09-21/DEPENDENCY_QUALIFICATION.md)
records the deployed pins and remaining verification limits. Local evidence is
not independent certification or proof of live funding, finality or profitability.

`backend/qualify_execution_fork.py` still deploys the internal base artifacts in
its disposable fork. Its results qualify those bases, not the public V1 source
entrypoint names. The public release uses `scripts/build-public-release.mjs` to
prove equivalence and `scripts/prepare-financial-release.mjs` to prepare and verify
the selected V1 targets with the authenticated artifact manifest.

Development is supported on macOS, Linux and WSL2. Native Windows installation
and testing are unsupported because the pinned Foundry npm installer uses POSIX
shell syntax. Use Linux-installed Node 24/Python 3 and a separate Linux checkout
inside WSL2; do not reuse Windows `node_modules`.

From the repository root:

```sh
npm ci
npm run test:contracts
npm run check:repository
```

The launcher uses the pinned native Forge binary and absolute offline compiler
paths, including checkout paths with spaces. By default it runs authored test
files sequentially, compiling each dependency closure to avoid whole-tree
solc-js memory exhaustion. Explicit `--match-path` selects one invocation;
other test filters pass through to each suite. Failed or terminated subprocesses
fail the command. For example:

```sh
node scripts/test-contracts.mjs --match-path test/DominoL2Block.t.sol
```

The default bytecode gate checks the seven internal base components. For the
public deployment targets, run:

```sh
node scripts/build-public-release.mjs
node scripts/check-contract-size.mjs --public-release
```

Both gates check exact compiler settings, constructor argument sizes,
EIP-170/EIP-3860 limits and the same architecture reserves. Current release
bytecode identities and sizes are in [release-artifacts.json](release-artifacts.json);
the [release procedure](../docs/FINANCIAL_RELEASE.md) describes independent
recompilation, authentication and verification of deployed runtime hashes.
Contract hygiene and launcher regressions run before the suite.
`npm run check:contract-gas` compares deterministic tests with
[.gas-snapshot](.gas-snapshot); increases require an explained baseline update.
Test gas is not a live deployment estimate or a complete Nitro transaction cost.

The sibling personal bot, its contracts, credentials and operational database
are outside this package. Mainnet preparation uses only explicit project inputs
and the [unsigned release procedure](../docs/FINANCIAL_RELEASE.md).

The current public V1 candidate is described in the [independent audit specification](../reports/V1_INDEPENDENT_AUDIT_SPEC_2026-09-21.md), including complete-suite reproduction and the distinction from the original frozen V4 baseline.
