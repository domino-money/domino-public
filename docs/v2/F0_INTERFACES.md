# Domino V2 — F0 interface freeze

F0 is the synchronization point of the V2 workstreams (domino-money/domino#283). It fixes the surfaces that more than one workstream depends on, so contracts (F1–F4), the bridge (F5), the backend (F6), the app (F7) and infrastructure (F8) can proceed in parallel against the same definitions. The technical base is in #282.

## Decisions this freeze encodes (owner, 1 Oct 2026)

- **Chains:** Robinhood Chain (4663), Base (8453), Arbitrum One (42161). Elysium is added when its mainnet is live with official Uniswap deployments.
- **DEX:** Uniswap v3 and v4 only, no forks for now. No chain id is hardcoded in V2 contracts, and nothing depends on ArbSys.
- **No V1 compatibility.** V1 keeps running until V2 automation replaces it.
- **Tariffs:**

  | Charge | Rate |
  | --- | --- |
  | Assisted swap in a manual action | 65 bps of the swapped amount |
  | Deposit from another chain | 35 bps, the bridge provider's app fee (a convenience fee) |
  | Automation, Auto-compound | 200 bps of consumed fees |
  | Automation, Domino-compound | 400 bps of consumed fees |
  | Auto-exit | 20 bps of the position at exit; the only exit charge, even with conversion |

- **Where a fee is collected.** Every v3/v4 pool is accepted; this rule only selects the token.
  - Each chain has an ordered list of charge currencies: Robinhood USDG then ETH; Base and Arbitrum USDC then ETH.
  - **Manual swaps:** the first listed currency among the input, the output, then a route hop. Otherwise the input token.
  - **Automation:** proportional in both pool tokens (unchanged).
  - **Auto-exit:** the listed token if the owner receives one. Otherwise the position's own tokens.
- **Deposit from another chain** is a plain bridge to the user's own wallet.
  - The bridge goes through the Relay or Across API with the provider's app fee (Relay `appFees`, Across `appFee`).
  - The position is created afterwards with S1.
  - The 35 bps is a convenience fee. Nothing on-chain enforces it, and anyone who does not want to pay it may bridge by other means.
  - There is no Domino bridge contract on either chain, and the one-signature flow with a destination contract is dropped.
- **Custody:** the NFT stays in the owner's wallet with an individual approval to the vault.
  - On v4 the vault is the position's subscriber.
  - On v3 the vault re-verifies the position on every execution.
  - Domino-compound successors are held by the vault.

## Layout

| Path | What |
| --- | --- |
| `contracts/src/v2/DominoV2Types.sol` | Shared structs, constants, EIP-712 type strings and hashing. The source of truth. |
| `contracts/src/v2/interfaces/` | The frozen external surfaces (below). |
| `contracts/src/v2/external/` | Minimal local declarations of Permit2 and Uniswap v3/v4, with every selector pinned to the deployed contracts in `DominoV2External.t.sol`. |
| `api-contracts/v2/chains/` | Verified per-chain profiles (below). |
| `api-contracts/v2/eip712.json` | Generated from the Solidity source: types, type strings, typehashes, domains, Permit2 witness. |
| `api-contracts/v2/eip712-goldens.json` | Fixtures with their struct hashes and digests, computed with eth_account. |
| `api-contracts/v2/abi/` | ABI, function selectors and ERC-165 id of every interface; `index.json` lists them. |
| `contracts/test/v2/` | `DominoV2Types.t.sol` (EIP-712 goldens and Permit2 witness), generated `DominoV2Interfaces.t.sol` (interface-id pins), generated `DominoV2Goldens.sol`. |
| `scripts/v2/eip712_exports.py` | Recomputes the EIP-712 exports with eth_account; `--check` fails on drift. Checked in CI by `backend/tests/test_v2_eip712_exports.py`. |
| `scripts/v2/export-abi.mjs` | Compiles `contracts/src/v2` with the pinned solc and writes the ABI exports and the pin test; `--check` runs in the CI contracts job. |

The backend and the app consume the JSON exports; they do not re-declare the interfaces or the EIP-712 types.

## Conventions

- **Compiler and limits:** Solidity 0.8.26 (the repository pin), EVM Cancun, and the 24,576-byte runtime limit. V2 targets several chains, so contracts stay modular.
- **Integer widths:**
  - token amounts per action are `uint128`, since v3/v4 deltas are 128-bit;
  - prices are sqrt prices in Q64.96 (`uint160`);
  - ticks are `int24`.
- **Pools and positions:**
  - `PoolRef` describes a pool on either version. On v4 its five PoolKey fields keep their meaning. On v3, `fee` selects the pool, `tickSpacing` must match the factory and `hooks` is zero.
  - Native currency is `address(0)` on v4 only; v3 uses the wrapped token.
  - `PositionRef` is `(dex, positionManager, tokenId)`.
- **EIP-712 domain:** `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`, with name `Domino`, version `2`, and the signing contract as `verifyingContract`.
- **No block-hash binding.** Signed prices carry `observedAt`/`validUntil` timestamps and are voided by revocation or by the registry's observation epoch. This works the same on every chain.

## Signed types (EIP-712)

| Type | Signed by | Verified by | Purpose |
| --- | --- | --- | --- |
| `PriceObservation(PoolRef pool,uint160 sqrtPriceX96,uint64 observedAt,uint64 validUntil,uint64 nonce)` | An admitted publisher | `IDominoPriceAnchor` | The anchor for v4 pools. On v3 it is optional, since the pool's TWAP can serve instead. It replaces V1's on-chain publication transaction, which cost 157k gas per cycle. |
| `PositionIntent(uint8 action,PoolRef pool,uint256 tokenId,int24 tickLower,int24 tickUpper,uint128 minLiquidity,uint16 feeBps,address feeToken,bytes32 routesHash,address recipient,uint256 nonce,uint64 deadline)` | The owner | The zap or vault | The readable core of a manual action. It is the Permit2 witness in `createWithPermit` and `increaseWithPermit`. `routesHash = keccak256(abi.encode(SwapLeg[]))`. |
| `ExitMandate(address owner,address vault,uint256 tokenId,uint160 triggerBelowSqrtPriceX96,uint160 triggerAboveSqrtPriceX96,uint8 receiveMode,address convertTo,uint16 maxSlippageBps,uint64 validUntil,uint256 nonce)` | The owner (EOA, EIP-7702 account or EIP-1271 wallet) | `IDominoAutoExit` | One-shot exit order. A zero trigger is disabled; both triggers may be set. |
| `RelayedPositionAction(PositionIntent intent,uint128 liquidityToRemove,uint128 amount0MinRemoved,uint128 amount1MinRemoved,uint128 amount0Max,uint128 amount1Max,bool burn)` | The position's owner | The zap (`IDominoZap`) | Added in F2, in `contracts/src/v2/DominoV2RelayTypes.sol`. A relayed change of range or exit: the intent plus the removal bounds it does not bind. See docs/v2/F2_ZAP.md. |

`PoolRef(uint8 dex,address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)` is the nested type of the first two.

**Permit2 witness.**
- The witness type string is `PositionIntent witness)` followed by the PoolRef and PositionIntent type strings, then `TokenPermissions(address token,uint256 amount)`, as Permit2 requires.
- `DominoV2Types.t.sol` proves that Permit2's batch-witness hashing over this string equals the digest of the typed data a wallet signs for `PermitBatchWitnessTransferFrom` with a `PositionIntent` witness.
- The goldens for both come from eth_account.

## Interfaces

**`IDominoRegistry`** — per-chain roles and lists:
- operators, publishers and admitted routers (with version);
- charge-currency ranks;
- the fee recipient;
- the observation epoch;
- a global automation halt.

Anything that widens trust is scheduled by governance (`scheduleChange` with a `REGISTRY_*` kind) and executes after the timelock. The guardian acts at once, and only to narrow trust: remove a role, raise the epoch, halt automation. Owner exits never depend on it.

**`IDominoFeeEvents` / `IDominoFeeSettlement`** — how the zap, vault and auto-exit report and settle fees:
- `FeeCharged(kind, token, payer, amount, ref)`.
- When the transfer to the recipient fails, the amount becomes owed: `FeeDeferred`.
- `flushOwedFees` pays the owed amount to the current recipient. Anyone may call it.
- A recipient that cannot receive never blocks an action (audit A1).

**`IDominoPriceAnchor`** — `anchor(pool, evidence, maxAge, maxDeviation)`:
- returns the anchor (a signed observation, or a v3 TWAP) and the current spot after the band check;
- publisher or guardian can revoke a single observation; the registry epoch voids all earlier ones.

**`IDominoPositionActions`** — S1 manual management, implemented by the stateless zap (positions in the wallet) and by the vault (positions under automation, owner-only):
- `create` / `createWithPermit`, `increase` / `increaseWithPermit`, `changeRange`, `exit`.
- Plans carry the `PositionIntent`, the inputs, the swap legs and the amount bounds.
- A swap leg (`SwapLeg`: Universal Router call, v3 path or v4 path) is accepted by its effect:
  - exactly `amountIn` leaves;
  - at least `minAmountOut` arrives;
  - nothing else moves;
  - no allowance survives.
- The fee is checked against the charge-currency rule: `intent.feeToken` must equal the selection.
- Nothing stays in the contract after an action.

**`IDominoZap`** (added in F2, docs/v2/F2_ZAP.md) — what the stateless zap adds:
- `changeRangeWithSignature` and `exitWithSignature`, which a relayer submits with the owner's `RelayedPositionAction`;
- `nonceBitmap` and `invalidateNonces` for those signatures;
- the receipt events `InputPulled` and `PositionLiquidityChanged`.

**`IDominoVault` / `IDominoVaultFactory`** — the owner, app and indexer surface of automation:
- policy and limits, pause and resume, rearm;
- reserve and child withdrawals, `recoverToken` for any unaccounted token;
- `exitAll`, and the auto-exit module switch.

`Limits.maxSlippageBps` excludes the pool's own fee: the swap floor is the spot quote, less the pool's total fee (LP plus protocol), less this slippage. This is the #3409682 fix.

**`IDominoVaultExecution`** — the operator's entry point, `execute(bytes plan)`:
- a draft owned by F3;
- the plan encoding is versioned in its first byte and freezes when F3 freezes;
- F6's planner and F3 define it together.

**`IDominoAutoExit`** — S3:
- `registerMandate(mandate, signature)` (anyone submits; the owner signs);
- `revokeMandate` (owner only, any time);
- `execute(mandateHash, execution)` (admitted operator, after the anchor crosses a trigger);
- `mandateStatus`.

Consent takes two explicit acts: the vault's `setExitModule` and the mandate signature. The fee is 20 bps of each token withdrawn, or of the converted output.

## Chain profiles

`api-contracts/v2/chains/<slug>-<chainId>.json` holds each enabled chain: `robinhood-4663`, `base-8453`, `arbitrum-42161`. `elysium.json` is a disabled placeholder that lists what must hold before it is enabled. Every address in an enabled profile was read on-chain on 1 Oct 2026, and the profile records the block, each contract's code hash and its sources. Each profile carries:
- the Uniswap v3 factory, position manager, QuoterV2, SwapRouter02 and pool init code hash (`0xe34f199b…7b8b54` on all three chains);
- the v4 PoolManager, PositionManager, StateView and V4Quoter;
- Universal Router 2.1.2 (2.0 and 2.1.1 are sunset on 21 Oct 2026; never use them);
- Permit2, Multicall3, CreateX and the wrapped native token;
- the charge currencies in rank order: the stable first, then ETH/WETH;
- the Chainlink ETH/USD feed used to price gas;
- the bridge providers and the 35 bps app fee.

`backend/tests/test_v2_chain_profiles.py` checks the checksums, the ranks the fee rule depends on, and that every contract V2 uses is present and verified.

**Facts that differ by chain:**
- **Stack:** Robinhood and Arbitrum are Nitro (`block.number` is the parent chain's; ArbSys gives the L2 number). Base is OP Stack, with 2 s blocks plus 200 ms Flashblocks. V2 uses timestamps, so none of this matters to its contracts.
- **Fee tiers:** Base's v3 factory enables more than the four standard tiers (200/300/400 bps → spacing 4/6/8). The profiles list only 100/500/3000/10000; read `feeAmountTickSpacing` for anything else.
- **Chainlink on Robinhood:** the ETH/USD heartbeat is 24 h with 0.5% deviation, and Chainlink publishes no sequencer-uptime feed for Robinhood.

## Deterministic deployment

**Mechanism.** V2 deploys through CreateX (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`), which is present with the same code hash on all three chains. It uses `deployCreate3`, so a component's address depends only on CreateX and the salt, not on its constructor arguments. Every component therefore has the same address on every chain even though it is configured per chain (position managers, routers).

**Salt.** `deployer (20 bytes) ‖ 0x00 ‖ bytes11(keccak256("domino.v2.<component>"))`:
- the deployer prefix makes the salt usable only by the deployer;
- `0x00` disables the per-chain salt, which is what makes the address identical on every chain.

**Components:**
- `registry`, `priceAnchor`, `autoExit`;
- `zap.v3` and `zap.v4`, and `zap.v4.steps` (added in F2: the v4 zap's position steps, reached by DELEGATECALL);
- `vault.v3` and `vault.v4` (implementations);
- `vaultFactory.v3` and `vaultFactory.v4`.

**Deployer key.** The owner holds it; it never passes through an agent.

**Elysium.** The testnet has no CreateX. Its mainnet needs CreateX placed first, through the parent chain's Inbox (how Nitro places other deterministic deployers) or a request to CreateX's maintainers.

## Uniswap constraints the implementations must respect

These were confirmed against the deployed contracts on all three chains, not only the vendored sources.

**Authorization:**
- **v3:** `decreaseLiquidity`, `collect` and `burn` need the owner or an approval. `mint` and `increaseLiquidity` are open; the payer is the caller, through a plain ERC20 allowance to the position manager.
- **v4:** INCREASE, DECREASE and BURN all need the owner or an approval of the locker. So on v4 even an increase needs the vault's or the zap's approval. MINT is open; payment goes through Permit2 from the locker.

**Fees:**
- In v4, every liquidity change credits the position's accrued fees to the caller's delta, so an increase settles uncollected fees.
- In v3, fees accrue in `tokensOwed` until `collect`.

**v4 custody:**
- A transfer unsubscribes the position and clears its approval. After any transfer the vault has lost both and automation stops until the owner re-approves and re-subscribes.
- `notifyModifyLiquidity` and `notifyBurn` block the owner's change if the subscriber reverts. Domino subscribers must disarm, never revert, on a change the owner started.
- `notifyUnsubscribe` runs best-effort with 300,000 gas.
- There is no transfer notification.

**Protocol fees** come before the LP fee and count in the swap floor:
- v3: `slot0.feeProtocol` (1/N of the swap fee per side);
- v4: `getSlot0().protocolFee` (pips per direction, 12 bits each).

**Universal Router 2.1.2:**
- V3 swap and v4 swap encodings carry `minHopPriceX36`, which 2.0 does not.
- Command bytes are masked with `0x7f`.
- Pin the router per chain from the profile.

**Permit2 and EIP-7702.** Owners with code, including EIP-7702-delegated EOAs, are verified through EIP-1271, so a delegate without `isValidSignature` cannot sign Permit2 permits. The plain `create`/`increase` path (approve, then call) stays available for them.

**Testing.** The vendored v4 copy under `contracts/test/reference` is newer than what is deployed (it emits `ModifyPosition`; mainnet does not). Behaviour that matters must be tested on forks of the deployed contracts.

## What is frozen, and how it changes

**Frozen:**
- every type string, struct layout and function signature exported in `api-contracts/v2/`;
- the tariff constants;
- the events.

**Not frozen:**
- `IDominoVaultExecution`'s plan encoding, owned by F3;
- implementation details behind the interfaces.

**To change a frozen surface:**
1. Edit the Solidity.
2. Run `python3 scripts/v2/eip712_exports.py` (with the backend dependencies) and `node scripts/v2/export-abi.mjs`.
3. Commit the regenerated exports together with the change.

The pinned interface ids and the EIP-712 goldens make every such change visible in review; CI fails on any drift. Additive changes (a new function or interface) are expected while F1–F4 implement. Changing or removing what other workstreams already consume needs their agreement in #283.
