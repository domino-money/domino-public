# Domino V2 — F1a: registry and price anchor

F1a is the part of F1 ("Contratos: fundação", domino-money/domino#283) that implements two F0 surfaces: `IDominoRegistry` and `IDominoPriceAnchor`. The technical base is in #282: signed observations instead of on-chain publication (B1), a global operator and publisher registry with fleet-wide revocation (A4), a rotatable guardian with cancellable proposals, a delay and mass invalidation (A13), and a rotatable fee recipient (A1). F0 is unchanged: both contracts implement the frozen interfaces as exported in `api-contracts/v2/`.

## Layout

| Path | What |
| --- | --- |
| `contracts/src/v2/registry/DominoRegistry.sol` | `IDominoRegistry`: roles, lists, timelocked changes, the guardian. |
| `contracts/src/v2/anchor/DominoPriceAnchor.sol` | `IDominoPriceAnchor`: signed observations, v3 TWAPs, the spot read and the band. |
| `contracts/src/v2/anchor/AnchorMath.sol` | The band check and the TWAP mean tick. The tick conversion comes from the shared vendored v4-core `TickMath` in `src/v2/positions/uniswap` (F1c). |
| `contracts/test/v2/registry/` | `DominoRegistry.t.sol` and the shared cheatcode interface and fixtures. |
| `contracts/test/v2/anchor/` | `DominoPriceAnchor.t.sol` (doubles), `AnchorMath.t.sol`, `DominoPriceAnchorV3Deployed.t.sol` (deployed v3 pool bytecode), `DominoPriceAnchorV4Official.t.sol` (vendored PoolManager and StateView). |
| `contracts/mutations/v2-f1-registry-anchor-2026-10-01.json` | The mutation batch: every guard of the three sources, deleted or weakened. |

Runtime sizes, against the 24,576-byte limit: `DominoRegistry` 7,091 B, `DominoPriceAnchor` 7,529 B. Both suites also assert the limit.

## Registry

### Who can do what

| Actor | Immediately | Through the timelock | Never |
| --- | --- | --- | --- |
| Governance | everything the guardian can do; `transferGovernance` (two-step, the new address accepts) | `scheduleChange`, then `executeChange` once ready | skip the timelock |
| Guardian | `removeOperator`, `removePublisher`, `removeRouter`, `raiseObservationEpoch`, `haltAutomation`, `cancelChange` of any change except a guardian change | — | admit anything, resume automation, change the fee recipient, the timelock or itself |
| Anyone else | — | — | any state change |

`executeChange` is governance-only, so a change queued by an earlier governance runs only if the current one chooses to.

### Changes

`scheduleChange(kind, data)` validates the data at once. `data` is the canonical ABI encoding listed with each kind in `DominoV2Types`: exact length, no dirty bits.

| Kind | `data` | Refused at scheduling | Effect at execution |
| --- | --- | --- | --- |
| `REGISTRY_OPERATOR` | `(address, bool)` | zero address; flag other than 0/1 | admits or removes; refuses to admit a publisher |
| `REGISTRY_PUBLISHER` | `(address, bool)` | same | admits or removes; refuses to admit an operator |
| `REGISTRY_ROUTER` | `(address, uint16 version)` | a version from 1 to 211 (Universal Router 2.0 and 2.1.1 are sunset on 21 Oct 2026); admitting a router without code; zero address | sets the version (212 or later, e.g. 2.1.2 = 212, 2.2.0 = 220); 0 removes |
| `REGISTRY_CHARGE_CURRENCY` | `(address, uint8 rank)` | a nonzero rank for a token without code (`address(0)` is native ETH) | sets the rank; 0 removes; ranks may repeat (ETH and WETH share rank 2) |
| `REGISTRY_FEE_RECIPIENT` | `(address)` | zero address | sets the recipient |
| `REGISTRY_GUARDIAN` | `(address)` | zero address | replaces the guardian |
| `REGISTRY_TIMELOCK` | `(uint32)` | below 1 hour or above 30 days | applies to changes scheduled afterwards |
| `REGISTRY_RESUME_AUTOMATION` | empty | any data | clears the halt |

An unknown kind is refused. Each change gets a fresh id (`keccak256(kind, data, counter)`), so the same change can be queued twice. `ChangeScheduled`, `ChangeExecuted` and `ChangeCancelled` carry it, and `pendingChange(id)` returns a pending change.

### The guardian's emergency actions cannot be undone quietly

Every narrowing records its time: a role removal (by the guardian, by governance, or by a scheduled removal), and each `haltAutomation`.

A re-admission of that subject, or a resume, executes only if it was **scheduled after** that time; one scheduled in the same second or earlier reverts with `InvalidChange`. So:

- a change queued before an emergency cannot reverse it;
- every undo gives the guardian a full timelock to cancel it;
- the guardian can void pending admissions of an address without knowing their ids, by removing it even if it holds no role;
- calling `haltAutomation` again while halted voids resumes queued since the previous halt.

`removedAt(kind, subject)` and `haltedAt()` expose these times.

### Why the guardian cannot cancel a guardian change

Otherwise a lost or compromised guardian could block its own replacement and, through `cancelChange`, every other change forever.

With this rule:

- **A compromised guardian** costs at most two timelocks of automation (exactly two timelocks and one second: a change cannot execute in the second the guardian acts). It can halt, remove and cancel, but not its own replacement. Governance replaces it after one timelock, then restores what it removed after a second.
- **A compromised governance** needs two timelocks to defeat an honest guardian: one to replace it, one for the change it was vetoing. Throughout, the guardian can halt automation and remove every role, and owners can exit, since exits never read the registry.

### Other rules

- **Operators and publishers are disjoint.** The key that executes never attests the price that bounds its own execution. The deployment configuration is checked the same way.
- **The observation epoch** only rises and never passes `block.timestamp`. It voids the past and can never block observations made from now on. Observations with `observedAt` equal to the epoch stay valid, so a compromised publisher key is handled by `removePublisher`, which voids all its observations immediately. The epoch is for voiding everything signed so far by everyone.
- **The deployment configuration** (governance, guardian, timelock, fee recipient, operators, publishers, routers, charge currencies) applies without a delay. The deployment is the governance act that sets it. The constructor emits the same events as the changes would, so an indexer rebuilds the state from logs. The one exception is the timelock's value, which no event carries: `timelockSeconds()` gives it, and so does the first scheduled change's `executableAt`.

## Price anchor

### Evidence

`anchor(pool, evidence, maxAgeSeconds, maxDeviationBps)` reads the spot first, then the anchor, then checks the band. `evidence` takes one of two forms:

- **Exactly 32 bytes** is `abi.encode(uint32 secondsAgo)`: a v3 TWAP.
- **Anything else** must decode as `abi.encode(PriceObservation, bytes signature)`, and the observation must name the requested pool in all six `PoolRef` fields.

It returns `(anchorSqrtPriceX96, spotSqrtPriceX96)`.

### Signed observations

The publisher signs the EIP-712 digest of `PriceObservation`:

- domain name `Domino`, version `2`, the current chain id, and the anchor as `verifyingContract`;
- the domain is cached and recomputed if the chain id or the contract address differs (forks, etched copies);
- `hashObservation(point)` returns the digest, which is also the hash `revokeObservation` and `isRevoked` take.

`verifyObservation(point, signature, maxAgeSeconds)` and the observation branch of `anchor` apply these checks in this order:

| Check | Error |
| --- | --- |
| `sqrtPriceX96` within `[MIN_SQRT_PRICE, MAX_SQRT_PRICE]` | `InvalidObservation` |
| `observedAt <= block.timestamp`: an observation dated in the future is refused | `InvalidObservation` |
| `block.timestamp <= validUntil` | `ObservationExpired` |
| `validUntil - observedAt <= maxAgeSeconds` | `ObservationExpired` |
| 65-byte `(r, s, v)` signature with `s` at most half the curve order, recovering a nonzero address | `InvalidObservation` |
| the signer is an admitted publisher **now** (removal voids its observations at once) | `InvalidObservation` |
| the digest is not revoked | `ObservationRevoked` |
| `observedAt >= registry.observationEpoch()` | `ObservationRevoked` |

**Freshness.** The window rule, `observedAt <= now` and `now <= validUntil` together bound the age at use by `maxAgeSeconds`. No key can pre-sign observations that outlive the window it gave them, and there is no block-hash binding: this works the same on every chain.

**Not a nonce.** An observation is an attestation, not an authorization. Anyone may present it again while it is valid. `nonce` only distinguishes two observations that would otherwise hash alike, so each can be revoked alone. Replay across pools, contracts and chains is what the signature binds.

**Revocation:**
- by any admitted publisher, the guardian or governance; anyone else gets `Unauthorized()`;
- a hash may be revoked before it is ever used;
- revoking twice reverts `ObservationRevoked`.

### v3 TWAP

- **The pool.** It is derived by CREATE2 from the factory and init code hash, as Uniswap's `PoolAddress` computes it: no factory call, and a genuine pool by construction.
- **The read.** `observe([secondsAgo, 0])`. The mean tick is rounded toward negative infinity with the int56 difference wrapping, exactly as `OracleLibrary.consult`. The sqrt price is that tick's.
- **The window in `anchor`** must lie within `[minTwapSeconds, maxAgeSeconds]`:
  - the operator picks it, and the floor keeps it from picking one short enough to move by holding a manipulated price for a few blocks;
  - the ceiling keeps the anchor from containing prices older than the caller allows.
- **Same-block manipulation** cannot reach the TWAP. A swap writes the block's observation with the pre-swap tick before moving the price.
- **Too-short history.** A window older than the pool's history (Uniswap's `OLD`) is `TwapUnavailable`, as are a v4 pool, a zero window and a mean tick outside the tick range. Pools need enough observation cardinality (`increaseObservationCardinalityNext`). The V2 automation does not pay for it (the owner's decision of 5 Oct 2026): when a pool's own history cannot guarantee the window, it anchors on a signed observation instead ([V2_AUTOMATION_BACKEND.md](V2_AUTOMATION_BACKEND.md), "A v3 vault's anchor"). The anchor only fails closed.
- **`twapSqrtPrice(pool, secondsAgo)`** is the raw reading: any nonzero window the history covers, without the floor or the maximum.

### Spot

- **v4:** `StateView.getSlot0(keccak256(abi.encode(PoolKey)))`. An uninitialized pool (sqrt price 0) is `PoolUnavailable()`.
- **v3:** `slot0` and `tickSpacing` of the CREATE2-derived pool. `PoolUnavailable()` when:
  - no pool is deployed there;
  - the pool is uninitialized;
  - it is **locked**, that is, in the middle of one of its own swaps, mints or burns. Read-only reentrancy from a callback, where the price has moved but nothing has been paid yet, is refused.
  - the reference has a hook;
  - its tick spacing differs from the pool's (a v3 `PoolRef` stays canonical, as F0 requires).
- **Either version:** an unknown `dex`, or a version the deployment does not serve (constructor address zero), is also `PoolUnavailable()`.

`spotSqrtPrice(pool)` is the same read on its own, for consumers that re-check the price after a swap.

### The band

`AnchorMath.withinBand(a, b, d)` is true when `max(a, b)^2 * 10000 <= min(a, b)^2 * (10000 + d)`, on the **price** (the square of the sqrt price):

- **Symmetric.** The spot may be at most a factor `1 + d/10000` above or below the anchor, whichever token is the base. For a 100 bps band that is +1% above and −0.990% below on token1-per-token0, and the same seen the other way.
- **Exact.** Both sides are full 512-bit products, so there is no rounding at the edge and no overflow or revert anywhere in the uint160 range.
- **Total.** Every `uint16` deviation is meaningful.
- **Zero.** A zero price is outside every band.

### Errors

The interface's `InvalidObservation`, `ObservationRevoked`, `ObservationExpired`, `TwapUnavailable` and `SpotOutsideBand`, plus three of the implementation's own:
- `PoolUnavailable()`, above;
- `Unauthorized()`, for revocation;
- `InvalidConfig()`, from the constructor.

The interface does not declare them. An additive F0 change could add `PoolUnavailable` to `IDominoPriceAnchor` if consumers want to decode it from the exported ABI.

### Gas

Measured as the gas of one external call, first call in the transaction (every account cold) and the same call again (warm). Cancun, the repository's compiler profile, on the vendored v4 PoolManager and StateView and on the deployed v3 pool bytecode:

| Call | Cold | Warm |
| --- | ---: | ---: |
| `anchor`, v4 pool, signed observation | 29,662 | 16,058 |
| `anchor`, v3 pool, signed observation | 28,092 | — |
| `anchor`, v3 pool, 300 s TWAP over a three-observation history | 35,488 | 18,316 |
| `isOperator` + `automationHalted` on the registry | 10,883 | — |

V1's equivalent was a 157k-gas publication transaction per cycle, plus the reads at execution (#282, B1). A v3 TWAP on a pool with a long history adds one cold storage read per step of observe's binary search.

## Internal API for the other fronts

**Vault (F3) and auto-exit (F4).** One call per execution:

```solidity
(uint160 anchorSqrtPriceX96, uint160 spotSqrtPriceX96) =
    IDominoPriceAnchor(anchor).anchor(pool, plan.anchorEvidence, limits.maxObservationAgeSeconds, limits.maxPriceImpactBps);
```

It reverts unless the anchor is valid and the spot is inside the band. After a swap, re-check with:

```solidity
AnchorMath.withinBand(anchorSqrtPriceX96, DominoPriceAnchor(anchor).spotSqrtPrice(pool), maxDeviationBps)
```

`AnchorMath` is an internal library, so the vault can import it from `contracts/src/v2/anchor/AnchorMath.sol`.

**Registry reads:**
- `isOperator(msg.sender)` and `automationHalted()` gate operator executions;
- `routerVersion(router) != 0` admits a Universal Router leg (every admitted version is 212 or later; the value tells the planner which encoding to use);
- `chargeCurrencyRank(token)` drives the charge-currency rule (lower rank first; 0 is not a charge currency);
- `feeRecipient()` is where fees and `flushOwedFees` go.

`observationEpoch` and `automationHalted` share one storage slot, so reading both costs one cold `SLOAD`.

**Publisher service (F6):**
- sign `PriceObservation` with this domain, using as `observedAt` the timestamp of the block the price was read at (never a wall clock ahead of the chain);
- keep `validUntil - observedAt` within the consumers' `maxObservationAgeSeconds`;
- use a distinct `nonce` for observations that would otherwise be identical;
- `api-contracts/v2/eip712.json` has the types; `hashObservation` gives the digest on chain.

**Monitoring (F6, F8):**
- watch `ChangeScheduled` and decode `pendingChange(id)`;
- `removedAt(kind, subject)` and `haltedAt()` tell whether a pending admission or resume is already void;
- `ObservationRevokedBy` lists revocations.

## Governance procedures

| Situation | Who | Calls |
| --- | --- | --- |
| Admit an operator, a publisher or a router | governance | `scheduleChange(REGISTRY_OPERATOR, abi.encode(addr, true))` (or `REGISTRY_PUBLISHER`, or `REGISTRY_ROUTER` with the router's version, `uint16(212)` for 2.1.2). After the timelock, `executeChange(id)`. Before scheduling a router, check its address and code hash against `api-contracts/v2/chains`. |
| An operator or publisher key leaks | guardian | `removeOperator` **and** `removePublisher`, at once: removal is per role, so a leaked key's pending admission to the other role becomes executable once it no longer holds the first (the adversarial suite pins it). For a publisher, every observation it signed is void from that block; `raiseObservationEpoch(block.timestamp)` also voids every earlier observation of every publisher, but never one dated in the future (the epoch never passes the clock). **Never re-admit a leaked key**: its future-dated observations would be valid again. Re-admitting an address needs a change scheduled after the removal. |
| One observation is wrong | its publisher or the guardian | `revokeObservation(hashObservation(point))`. |
| Stop automation everywhere | guardian | `haltAutomation()`. Resuming takes `scheduleChange(REGISTRY_RESUME_AUTOMATION, "")` after the halt, then the timelock. |
| Veto a pending change | guardian | `cancelChange(id)`; not a guardian change. |
| Rotate the fee recipient (A1) or the guardian (A13) | governance | `REGISTRY_FEE_RECIPIENT` or `REGISTRY_GUARDIAN`, through the timelock. The guardian cannot cancel its own replacement. |
| Change the timelock | governance | `REGISTRY_TIMELOCK`, through the current timelock; it applies to later changes only. |
| Move governance | governance, then the new address | `transferGovernance(next)`, then `acceptGovernance()` from `next`. `transferGovernance(address(0))` withdraws an offer. The hand-over is immediate and outside the guardian's veto, and an offer never expires: monitoring watches `GovernanceTransferStarted` and withdraws a stale offer. Never hand governance to the guardian's address: nothing on chain refuses it, and that address could then cancel guardian changes. |
| A new Universal Router version | governance | `REGISTRY_ROUTER` with its version (above 212), through the timelock, after checking the address and code hash. No new registry is needed. Retire the old router with `REGISTRY_ROUTER` version 0 or the guardian's `removeRouter`. Versions below 212 (2.0, 2.1.1) are refused. |

## Deployment parameters

Deployed on Robinhood, Base and Arbitrum on 4 Oct 2026 from `v2-release-2026-10-04`, with the owner's roles (provided on 2 Oct, #301): `docs/deployments/v2-mainnet-2026-10-04` and one verified manifest per chain. The fork rehearsal of 2 Oct 2026 (`docs/deployments/v2-rehearsal-2026-10-02`) had deployed the same configuration on forks of the three chains. The deployer key is the owner's.

**Salts** (CreateX `deployCreate3`, docs/v2/F0_INTERFACES.md): `deployer (20 bytes) ‖ 0x00 ‖ bytes11(keccak256("domino.v2.<component>"))`.

| Component | `keccak256("domino.v2.<component>")` | bytes11 suffix |
| --- | --- | --- |
| `registry` | `0x5808207249734df963985c10f0add93ae812a182d405ec579a0623137ec5ffed` | `0x5808207249734df963985c` |
| `priceAnchor` | `0x4c705838108da4e4e8af436d210e7a362d4aca645486c1a5272505190ce6ab6f` | `0x4c705838108da4e4e8af43` |

**The address.** With the sender prefix and the `0x00` flag, CreateX guards the salt as `keccak256(abi.encode(bytes32(uint256(uint160(deployer))), salt))`. `CreateX.computeCreate3Address(guardedSalt)` then gives the address, the same on every chain.

**Order.** Deploy the registry first on each chain: the anchor's constructor requires the registry to have code. The anchor takes the registry's CREATE3 address as its argument, and that address is known before either deployment.

**`DominoRegistry(Config)`:**

| Field | Robinhood (4663) | Base (8453) | Arbitrum (42161) |
| --- | --- | --- | --- |
| `routers` | `0x204FAca1764B154221e35c0d20aBb3c525710498` | `0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40` | `0x2d01411773c8C24805306E89A41F7855C3c4Fe65` |
| `chargeCurrencies` rank 1 | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| `chargeCurrencies` rank 2 | ETH `address(0)`, WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | ETH `address(0)`, WETH `0x4200000000000000000000000000000000000006` | ETH `address(0)`, WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| `governance` | the owner's multisig (address pending) | same | same |
| `guardian` | a separate key or multisig, held apart from governance (address pending) | same | same |
| `feeRecipient` | address pending from the owner | same | same |
| `timelockSeconds` | **86,400 (24 h)** | same | same |
| `operators`, `publishers` | the F6/F8 keys, disjoint | same | same |

**`DominoPriceAnchor(registry, v3Factory, v3PoolInitCodeHash, v4StateView, minTwapSeconds)`:**

| Argument | Robinhood (4663) | Base (8453) | Arbitrum (42161) |
| --- | --- | --- | --- |
| `registry` | the registry's CREATE3 address | same | same |
| `v3Factory` | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| `v3PoolInitCodeHash` | `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54` | same | same |
| `v4StateView` | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | `0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71` | `0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990` |
| `minTwapSeconds` | **60** | same | same |

The addresses are those of `api-contracts/v2/chains` (verified on chain on 1 Oct 2026). A chain without one Uniswap version passes zero for it (zero factory with zero hash, or zero StateView); at least one version is required.

## Verification

**Suites.** One at a time (`node scripts/test-contracts.mjs --match-path <suite>`); the V1 size gate that follows each run passes:

| Suite | Tests | What it proves |
| --- | ---: | --- |
| `test/v2/registry/DominoRegistry.t.sol` | 45 | deployment refusals, unauthorized callers, timelock edges, ids, cancellation and the guardian-change exception, every kind's validation and effect, router versions (211 and below refused; 212, 213, 220 and 65535 admitted), rank changes, the narrowing invariant (earlier, same-second and later changes), governance transfer, fuzzed kinds and dirty words |
| `test/v2/anchor/DominoPriceAnchor.t.sol` | 42 | goldens; every signed field, the contract and the chain bound; publishers only; malformed, trailing-byte, malleated and zero-signer signatures; future, expired and over-long observations; tick-range edges; revocation (who, twice, before use, per observation); epoch boundary; reuse within the window; pool mismatch per field; exact band edges both ways; TWAP window, rounding, int56 wrap, short history, missing pool, tick range; spot refusals; disabled versions; constructor refusals; CREATE2 against the three chains' deployed pools |
| `test/v2/anchor/AnchorMath.t.sol` | 9 | the shared vendored TickMath equals the reference upstream at every bit and under fuzzing, and out-of-range ticks revert alike; the band equals an independent FullMath formulation and 19 exact vectors computed with Python integers, and is symmetric and monotonic; the mean tick equals OracleLibrary's |
| `test/v2/anchor/DominoPriceAnchorV3Deployed.t.sol` | 7 | the deployed Base WETH/USDC 0.05% pool bytecode (`eth_getCode` at block 52058165, code hash equal to the profile's; storage layout checked against the live pool's getters when taken): interpolation, extrapolation to now, `OLD`, the lock, the spacing |
| `test/v2/anchor/DominoPriceAnchorV4Official.t.sol` | 4 | the vendored PoolManager and StateView: the PoolId derivation (with a hook, the dynamic-fee flag and the largest spacing) and the spot read |

**Signatures.** At the F0 golden verifying contract on chain 4663:
- the anchor's domain separator and the `PriceObservation` digest equal the eth_account goldens (`DominoV2Goldens`);
- a signature of the golden produced by eth_account 0.13.7 verifies, with the test key `keccak256("domino.v2.f1.publisher")`;
- Forge's `vm.sign` produces the same bytes (RFC 6979 on both sides).

**Mutation.** `contracts/mutations/v2-f1-registry-anchor-2026-10-01.json` deletes or weakens every guard of the three sources, one at a time, and was run with `scripts/mutate-contracts.mjs`'s own `makeSandbox` and `runBatch`. The suites do not build the V1 contracts that the size gate after each run inspects, so `contracts/out` and `contracts/cache` were copied into the sandbox before `runBatch`.

**Result at commit 476c74f: 96 mutations, 96 caught**, with every baseline passing first (registry 45, anchor 42, math 9):
- 38 in `DominoRegistry`, including three on the router rule: below 212 refused; 212 itself admitted (`<=` is caught already in `setUp`); later versions admitted (the former `!=` rule);
- 51 in `DominoPriceAnchor`;
- 7 in `AnchorMath`.

The tick-range guard is no longer F1a's to mutate: it lives in the shared `TickMath`. Before the rebase and the router change, the batch had 95 mutants, all caught (commit 94fbc62, rebased as 6ec1ebf).

The first run, with 92 mutants, left two survivors, and both were fixed:
- **"execution needs a pending change."** An unknown id has kind 0, which fell through `_apply`'s final branch into the resume rule and reverted there by accident. The dispatch now names every kind, so the existence check alone refuses an unknown id.
- **"the domain follows the contract address."** The golden test also changes the chain, which masked the address clause. A same-chain test at another address now covers it.

**Other checks:** `node scripts/check-contract-hygiene.mjs`, `node scripts/v2/export-abi.mjs --check` (it compiles the new sources too; the 19 exported interfaces are unchanged), `node scripts/gas-baseline.mjs --check` and `python3 scripts/check-repository.py`; results are in the PR.

No RPC is needed by any suite. The deployed v3 bytecode is committed in `UniswapV3PoolRuntime.sol`, which is GPL-2.0-or-later, the license of the v3-core code it was compiled from.

## Owner decisions (2 Oct 2026)

All recorded in the deployment parameters above:

1. **Timelock:** 24 h on each chain.
2. **Governance and guardian:** governance on a multisig, with a separate guardian. The owner provided the addresses, and the fee recipient's, on 2 Oct 2026 (#301); the rehearsal manifests carry them.
3. **TWAP floor:** `minTwapSeconds` is 60 on all three chains: 600 Robinhood blocks, 240 on Arbitrum, 30 on Base.
4. **Router versions:** **212 or later**, still only through the timelocked governance change. A successor to 2.1.2 is admitted without a new registry, while the sunset 2.0 and 2.1.1 (and anything below 212) stay refused. The version is governance's label, so before scheduling, governance checks the address and code hash against the chain profile, and the guardian has the timelock to veto.
5. **Governance keeps the guardian's immediate powers.** It can remove a role, halt or raise the epoch at once, and revoke observations, which keeps those actions available if the guardian key is unreachable.
