# V4 contracts

The contracts the release deploys: [`DominoVaultV4.sol`](src/DominoVaultV4.sol) is the shipped vault - an owner-bound immutable clone with root subscription/rearm, operator revocation, policy guards and actual token/NFT exits, plus the `execution*` entry points a pinned engine calls inside one authenticated action; the fee-credit sinks are exposed through `executionCredit` and `executionConvert`, behind `_requireExecution`. [`DominoVaultFactoryV4.sol`](src/DominoVaultFactoryV4.sol) clones it, once the deployer has bound the implementation through `finalizeImplementation`. [`DominoExecutionEngineV4.sol`](src/DominoExecutionEngineV4.sol) is the non-custodial engine that holds the pool manager's unlock for one plan; [`DominoRoutingHelperV4.sol`](src/DominoRoutingHelperV4.sol) validates that plan before it runs and is the only production source that imports the vendored Uniswap tree (`FullMath`, `TickMath`, remapped by [`foundry.toml`](foundry.toml) into `test/reference/official-v4/`); [`DominoPriceGuardV4.sol`](src/DominoPriceGuardV4.sol) holds the published price observations every action must anchor to; [`DominoVaultReadHelper.sol`](src/DominoVaultReadHelper.sol) is the fixed stateless helper every clone pins by address and codehash; [`DominoSetup.sol`](src/DominoSetup.sol) is the deployment helper. The standing review of all of them is [CONTRACT_REVIEW_2026-09-19](../reports/CONTRACT_REVIEW_2026-09-19.md), and [V4_AUDIT_PACKAGE_2026-09-21](../reports/V4_AUDIT_PACKAGE_2026-09-21.md) is where an external reviewer starts: the freeze, the scope, the trust model, the known limitations and the index of every finding. Two checks keep the closed tracks closed: `scripts/check-contract-hygiene.mjs` (licence line, one pragma, no leftover markers, no unused or development-only imports) and `scripts/gas-baseline.mjs --check` against the committed [`.gas-snapshot`](.gas-snapshot), the gas of every deterministic test; a rise fails CI and needs a deliberate `--update` in the commit that causes it.

The V3 lineage - `DominoVault.sol`, `DominoVaultFactory.sol` and `DominoCompoundEngine.sol`: the E2 custody candidate and its same-NFT `compoundSelf` path - was retired on 20 September 2026. It was never publicly deployed and the release order named no V3 artifact. Its tests live on against V4: the custody suite in [`test/shared/CustodyBehaviour.sol`](test/shared/CustodyBehaviour.sol), the factory suite in [`test/DominoVaultFactoryV4Creation.t.sol`](test/DominoVaultFactoryV4Creation.t.sol) and the architecture suite in [`test/DominoVaultV4Architecture.t.sol`](test/DominoVaultV4Architecture.t.sol). Two things V4 does not carry over: `adoptChild` - a V4 vault acquires a child only by minting a successor inside an execution - and `validateAuthority`, whose decision the routing helper makes when it validates a plan. [E2 semantics](../docs/PUBLIC_VAULT_E2.md) and the [V3 compound candidate](../docs/PUBLIC_VAULT_V3_COMPOUND.md) are kept as records of the retired implementation. The #101 recovery refinement they describe - owner NFT exits by `transferFrom` that need no receiver hook, registration checkpoints readable after rearm, a nested root unsubscribe advancing authority during a native exit - is V4 behaviour and is pinned in the shared custody tests.

`IDominoVaultDraft.sol` is the draft interface V4 takes its `Policy` struct and events from; it is not the V4 ABI. `PolicyValidation.sol` supplies the guards initialization and policy writes use.

`FeeAccounting.sol` implements only the per-currency fee split for a no-swap path: gross used = net added + protocol cut, with unconsumed balances uncharged. The maximum service cut is 200 bps (2%). Floor rounding in integer token base units is an explicit owner-favoring policy. At 200 bps, consuming 49 base units charges zero and consuming 50 charges one; a zero rate and zero consumption are also valid. There is no rounding-up or minimum one-unit toll.

The library deliberately does not choose a universal minimum consumable amount. Its caller must enforce authorized fee-only spending and a reviewed economic minimum that covers the actual path's costs and owner-benefit requirements, or an explicitly capped project subsidy. Repeated dust consumptions remaining arithmetically valid do not make them approved automation. Token decimals, route costs and conservative economic evidence belong in that caller's reviewed policy. This slice implements no such execution planner or economic gate.

The public design removes the inherited 1500 bps liquidity-growth cap in favor of proven fee balances, exact execution budgets and price limits, all of which still need an on-chain execution implementation. Unit/fuzz tests check arithmetic, policy writes and specified authority transitions, not public-vault safety. Bounded fee-balancing swaps require a separate typed interface, accounting extension and review under the [reinvestment policy](../REINVESTMENT_POLICY.md); none is implemented here.

## Policy write boundary

E2 calls `PolicyValidation.validateInitial(policy, 1)` for its actual root-only atomic initialization and `validateUpdate` with the vault's own active membership before storing a new owner policy. Other implementations must preserve those guards. Both require nonzero membership within the policy's position cap. The count must describe the root plus actually registered children, never a supplied count. Enforcing the cap only when fees are later consumed is insufficient. The validator selects no default policy.

The former one-argument initialization guard is removed so a caller cannot silently omit membership validation. This changes an internal library call, not a deployed vault ABI. E2 and the synthetic harness both supply membership from their own state. E2 additionally establishes unique membership, authorization and custody atomically; the validator's acceptance of a count alone does not prove those properties.

| Field | Enforced domain and meaning |
| --- | --- |
| `serviceFeeBps` | 0–200 inclusive; uses the same cap and `ExcessiveFee` error as `FeeAccounting` |
| `triggerDistanceBps` | 0–2000 inclusive; independent from overlap |
| `maxOverlapBps` | 0–2000 inclusive; independent from trigger distance |
| `minimumIntervalSeconds` | 1–4,294,967,295 inclusive; zero is invalid |
| `maxPositions` | 1–255 inclusive, counting root plus registered children; a write cannot fall below actual membership |
| `version` | 1 initially, then exactly current + 1; zero, skipped/reused versions and overflow are rejected |
| `paused` | Explicit initial boolean; policy writes preserve it and dedicated pause/resume calls change it |

The interval and position type ceilings are representational bounds, **not approved operational/resource caps**. A real deployment must justify any tighter caps without widening approved fee/geometry limits or introducing implicit defaults. Membership comes from vault state, never an operator-supplied number. Fixtures' intervals, rates and position IDs are synthetic test inputs.

| Call | Required caller |
| --- | --- |
| Read getters | Anyone |
| `compoundSelf` (implemented by the separate V3 candidate) | Owner or currently registered operator, while unpaused and subject to all execution checks |
| `setPolicy` | Owner only |
| `pause` | Owner or currently registered operator for emergency stopping |
| `resume` | Owner only |
| Reserve and child-NFT withdrawals | Owner only, including while paused or the service is offline; fixed owner recipient and no exit toll |

E2 policy writes emit `PolicyChanged(version, stateNonce)`. E2 pause/resume events identify the actor and resulting state nonce; their ABI does not include the policy version used by the old harness. Withdrawal events identify the source/child, fixed owner recipient, actual reserve amounts where applicable, and resulting nonce. They follow the completed transfer. Historical source records still permit recovery of tracked reserves after a child leaves active membership.

The old synthetic harness permits `withdrawFeeReserves(tokenId, 0, 0)` for guard tests without transferring assets. E2 instead rejects all-zero reserve withdrawals, identifies the balance by source ID and current currency, and proves a nonzero transfer before emitting its withdrawal event. Do not treat the old harness's signature or zero-valued records as E2 behavior.

Every ordinary completed policy/authority/membership mutation and withdrawal in E2 advances `stateNonce` exactly once. At either counter's terminal value, new authority is prohibited while owner recovery remains possible without wrap; saturated counters remain saturated and `TerminalRecovery` identifies this exception. See the [E2 authority table](../docs/PUBLIC_VAULT_E2.md#authority-policy-and-exhaustion). Resuming must not revive a prior plan. Future financial execution still must enforce complete intent replay protection, deadlines, frequency, measured fee provenance, principal preservation, token compatibility and price bounds. Neither the old harness's freshness check nor E2's richer `validateAuthority` implements `compoundSelf`.

Tests assert exact custom-error bytes, inclusive bounds, rejection before storage changes, independent geometry, registered membership, owner/operator/stranger separation, transition logs, owner exits while paused, stale plans and nonce exhaustion. Fee fuzzing includes raw invalid inputs and dedicated excessive-rate/overspending cases instead of only clamping inputs into a valid domain. No `forge-std` package is needed; a small test-only Foundry log interface inspects emitted logs.

The [functional alpha scope](../ALPHA_SCOPE.md) now requires Domino successor creation/funding alongside self-compound. This interface still lacks those typed plans and their fee-balancing swap/accounting implementation; adding them and passing their separate evidence gates is required before alpha activation.

The approved [onboarding scope](../ONBOARDING_AND_POOL_DISCOVERY.md) also needs owner-funded balancing swaps, position creation, advanced bounded pool initialization plus first mint, and native-ETH accounting/refunds. These setup authorities must remain separate from fee-only operator actions. This package implements none of those integrations; a wallet-discovered token or a newly initialized pool does not bypass compatibility checks.

[PRICING_POLICY.md](../PRICING_POLICY.md) proposes a separately capped, owner-reviewed assisted-swap service fee during setup/manual management. The existing 2% earned-fee library does not implement that collection; do not reuse it to charge deposits or add another service charge to automated internal swaps. The setup path requires its own exact-input accounting, fee consent, recipient and recovery tests.

The existing personal contracts, manifests, configuration and deployment are not part of this package. The public design must undergo the independent review described in [SECURITY_SPEC.md](../SECURITY_SPEC.md) before handling assets.

## Local verification, including Windows

Contract development is supported on macOS and Linux, and **inside WSL2 on Windows**. Native Windows Command Prompt/PowerShell installation and contract testing are not supported: the pinned Foundry npm installer uses POSIX shell syntax. Use a separate Linux checkout and Linux-installed Node 24/Python 3 in WSL2; do not reuse Windows `node_modules` in that checkout.

From the repository root inside the supported environment:

```sh
npm ci
npm run test:contracts
npm run check:repository
```

Forge, Anvil and solc are pinned in the root lockfile; no global Solidity compiler, wallet, RPC key or funds are required. `scripts/test-contracts.mjs` invokes the pinned native Forge binary directly, sets absolute project/compiler paths (including paths with spaces), stays offline and propagates failed/terminated process status. This avoids the pinned npm launcher's swallowed child exit code. Launcher regressions run before the Solidity suite. Additional Forge filters can be passed with `npm run test:contracts -- --match-test testFloorAtFortyNineAndFiftyBaseUnits`.

The contract command also runs the bytecode gate after Forge. It checks the production vault/helper/factory artifacts, pinned compiler settings, constructor argument sizes and the architecture review reserve. See the [version-2 verification report](../reports/PUBLIC_VAULT_V2_ARCHITECTURE.md) for exact measurements and limits.
