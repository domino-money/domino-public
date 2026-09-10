# Public contract boundary — draft

`IDominoVaultDraft.sol` specifies the integration surface and its caller/event requirements. `PolicyValidation.sol` implements shared guards for initialization and policy writes. The test-only `PolicyWriteHarness` executes those guards against synthetic state and demonstrates permissions, events and stale-plan invalidation. There is still **no public vault implementation**: the harness holds no assets and supplies no token/NFT transfers, swaps, callbacks or compounding. Its synthetic withdrawal records do not prove real transfer receipts.

`FeeAccounting.sol` implements only the per-currency fee split for a no-swap path: gross used = net added + protocol cut, with unconsumed balances uncharged. The maximum service cut is 200 bps (2%). Floor rounding in integer token base units is an explicit owner-favoring policy. At 200 bps, consuming 49 base units charges zero and consuming 50 charges one; a zero rate and zero consumption are also valid. There is no rounding-up or minimum one-unit toll.

The library deliberately does not choose a universal minimum consumable amount. Its caller must enforce authorized fee-only spending and a reviewed economic minimum that covers the actual path's costs and owner-benefit requirements, or an explicitly capped project subsidy. Repeated dust consumptions remaining arithmetically valid do not make them approved automation. Token decimals, route costs and conservative economic evidence belong in that caller's reviewed policy. This slice implements no such execution planner or economic gate.

The public design removes the inherited 1500 bps liquidity-growth cap in favor of proven fee balances, exact execution budgets and price limits, all of which still need an on-chain execution implementation. Unit/fuzz tests check arithmetic, policy writes and specified authority transitions, not public-vault safety. Bounded fee-balancing swaps require a separate typed interface, accounting extension and review under the [reinvestment policy](../REINVESTMENT_POLICY.md); none is implemented here.

## Policy write boundary

Every future vault implementation must call `PolicyValidation.validateInitial(policy, registeredPositions)` during atomic owner-bound initialization and `validateUpdate` before storing a new owner policy. Both guards require nonzero membership within the policy's position cap. The initial count must describe the root plus every child actually registered by that initialization; it must be derived from the vault's own initialization state, never trusted as a supplied count. Enforcing the cap only when fees are later consumed is insufficient. The validator selects no default policy.

The former one-argument initialization guard is removed so a caller cannot silently omit membership validation. This changes an internal library call, not a deployed vault ABI. All current callers are the synthetic harness and contract tests and pass the actual fixture membership. A future implementation still must establish unique membership, authorization and asset custody atomically; accepting a count does not prove those properties.

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
| `compoundSelf` | Owner or currently registered operator, while unpaused and subject to all execution checks |
| `setPolicy` | Owner only |
| `pause` | Owner or currently registered operator for emergency stopping |
| `resume` | Owner only |
| Reserve and child-NFT withdrawals | Owner only, including while paused or the service is offline; fixed owner recipient and no exit toll |

Policy writes emit `PolicyChanged`. Pause/resume events include actor, policy version and resulting state nonce. Withdrawal events identify the source/child, fixed owner recipient, actual reserve amounts where applicable, and resulting nonce. Emit them only after the corresponding real operation completes. Historical source records must still permit recovery of tracked reserves after a child leaves active membership.

The synthetic harness permits `withdrawFeeReserves(tokenId, 0, 0)` for a known source: it advances the nonce and emits a zero-valued test record, without calling any token. This supports guard/nonce tests and does not establish a real transfer or select the public executor's behavior. Before implementation, the executor must explicitly choose whether to reject all-zero requests or support a documented no-transfer result; it must define nonce/receipt and indexer handling, avoid assuming tokens accept zero transfers, and prove any nonzero transfer completed before emitting its withdrawal receipt.

Every completed policy write, pause, resume, withdrawal and automation action advances `stateNonce` exactly once. Resuming must not revive a plan signed before a pause. Reuse/wrap is forbidden; the harness tests nonce exhaustion with an exact error. Future implementations still must enforce complete intent replay protection, deadlines, frequency, registered operator revocation, sequence ownership, pool/currency membership, fee provenance, principal preservation, reentrancy, token compatibility and price bounds. The harness's freshness check covers only policy version, nonce, caller and paused state; it is not `compoundSelf`.

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
