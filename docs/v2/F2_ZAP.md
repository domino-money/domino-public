# Domino V2 — F2 manual management (the zap)

F2 is service S1 of domino-money/domino#283 ("Gestão manual"), milestone M1, Domino V2's first revenue line. The technical base is #282. It implements `IDominoPositionActions` (F0) for positions that stay in the owner's wallet, on Uniswap v3 and v4, on Robinhood (4663), Base (8453) and Arbitrum One (42161). It builds on F1b (fees and the swap-leg executor, `docs/v2/F1_FEES_ROUTE.md`) and F1c (the v3/v4 position adapters, `docs/v2/F1_POSITIONS.md`), and duplicates neither.

| Source | What it is | CreateX component |
| --- | --- | --- |
| `contracts/src/v2/zap/DominoZapBase.sol` | Abstract: the plan rules, consent (caller, Permit2 witness, relayed signature), pulls, the assisted swap (F1b `DominoAssistedSwap`), refunds and receipt events. | — |
| `contracts/src/v2/zap/DominoZapV4.sol` | The v4 zap: position steps in its own PoolManager unlocks; native ETH is `address(0)`. | `zap.v4` |
| `contracts/src/v2/zap/DominoZapV4Steps.sol` | The v4 position steps (F1c `DominoV4Positions`), run by DELEGATECALL from the v4 zap's unlock callback. Stateless, no constructor arguments, refuses direct calls. | `zap.v4.steps` |
| `contracts/src/v2/zap/DominoZapV3.sol` | The v3 zap: plain NonfungiblePositionManager calls (F1c `DominoV3Positions`); WETH9 for native. | `zap.v3` |
| `contracts/src/v2/interfaces/IDominoZap.sol` | Additive F0 interface: relayed change of range and exit, their nonces, the receipt events. | — |
| `contracts/src/v2/DominoV2RelayTypes.sol` | Additive F0 EIP-712 type `RelayedPositionAction`, beside `DominoV2Types` (which is unchanged). | — |
| `contracts/test/v2/zap/` | Suites, test kit, Base fixtures helper. | — |
| `contracts/mutations/v2-zap-2026-10-02.json` | Mutation batch: every guard of `src/v2/zap`. | — |

## The owner's decisions this implements (1 Oct 2026)

- **Four flows, one transaction each:** create a position with a swap; increase it with a swap; change its range as the owner's own action; exit with conversion to one token, or to both tokens as withdrawn.
- **Consent is bound to the plan.** Permit2 `permitWitnessTransferFrom` (batch) carries the `PositionIntent` as witness, so a wallet without EIP-5792 (Rabby) still does everything with one signature. Actions that pull nothing (change range, exit) can be relayed with an EIP-712 signature of the owner (see [Relayed actions](#relayed-actions-and-the-f0-addition)).
- **Tariff:** the assisted swap pays 65 bps of the swapped amount (F1b's formula), in the token F1b's charge-currency rule selects. No swap, no fee: `feeBps` and `feeToken` are zero.
- **Non-custodial:** the NFT stays in the owner's wallet; nothing stays in the zap after an action, except fees owed to a recipient that could not receive them.
- **Pools with hooks are refused** (owner decisions of 2 and 3 Oct 2026). A later registry list of approved hooks would come with new zap and vault implementations; until then the constant stays off (see [Hooks policy](#hooks-policy)).

## The flows

Every action runs the same sequence, in `DominoZapBase._act`. All four plans are copied into one internal shape, so the four flows share one body (and the optimizer keeps one copy of it).

1. **The plan.** Checked before anything moves:
   - `intent.action` is the entry point's action;
   - `block.timestamp ≤ intent.deadline` (`PlanExpired`);
   - `intent.recipient` is neither zero nor the zap;
   - the pool is this zap's (`dex` 3 or 4) and passes the hooks policy;
   - `intent.routesHash == keccak256(abi.encode(plan.legs))`.
2. **Consent.** Who the owner is, and that they authorized this (see [Consent](#consent-what-the-app-signs)). An action on an existing position needs the position's **current owner**, never someone the position approved.
3. **Inputs.** Pulled from the caller, or through Permit2 from the signer.
4. **Withdraw** (change range, exit): remove `liquidityToRemove` from the position with the removal minima, collect its fees, burn it when asked. An exit without conversion pays the recipient directly; otherwise the tokens come to the zap.
5. **Assisted swap** (F1b `_assistedSwap`): the intent's fee terms are checked against the legs (`FeeMismatch`), the legs run and are accepted by their effect, and the fee is charged (or owed).
6. **Add** (create, increase, change range): v3 wraps native ETH for a WETH pool; the amounts are what the zap holds, minus owed fees, capped by `amount0Max`/`amount1Max`. Create and change range mint to `intent.recipient`, and increase adds to `intent.tokenId`. The liquidity must reach `intent.minLiquidity` (F1c `InsufficientLiquidity`). A create with `initSqrtPriceX96 ≠ 0` initializes the pool first, only if it has no price (#282 A11).
7. **Refund.** Every token the action touched goes to `intent.recipient`: native, the pool currencies, the inputs and every leg's output. Owed fees stay (F1b `_unowedBalance`).

| Flow | Position steps | Approval the owner gives the zap |
| --- | --- | --- |
| create | mint to `intent.recipient` | none |
| increase | increase `intent.tokenId` | **v4:** approve the NFT (v4 `INCREASE` needs it). **v3:** none |
| change range | withdraw `intent.tokenId` (optionally burn), then mint the new range to `intent.recipient` | approve the NFT (both versions) |
| exit | withdraw `intent.tokenId` (optionally burn); collect only with `liquidityToRemove = 0` | approve the NFT (both versions) |

Notes per version:
- **v4.** Each position step runs in its own PoolManager unlock held by the zap. The callback runs the step by DELEGATECALL to `DominoZapV4Steps`, so the PositionManager sees the zap as locker and payer. Swap legs run between steps with their own unlocks (F1b), which keeps every leg kind (router, v3, v4) available.
  - The callback accepts only the PoolManager, and only for the step the zap registered (transient hash).
  - A v4 increase credits the position's accrued fees to the zap, netted against the payment (F1c). They leave with the refund, to `intent.recipient`. In the permit path that is the owner; in the plain path the owner chose it.
- **v3.** Plain calls; F1c approves the manager for exactly the amounts and resets to zero in the same call. v3 increase leaves the position's fees owed in the NFT, as v3 does.

## Consent: what the app signs

The frozen interface has no owner parameter, so the zap derives the owner per entry point:

| Entry point | Owner (payer, fee payer) | What authorizes it | Nonce |
| --- | --- | --- | --- |
| `create`, `increase`, `changeRange`, `exit` | `msg.sender` | the transaction itself | `intent.nonce` is not used |
| `createWithPermit`, `increaseWithPermit` | `intent.recipient` | Permit2 batch witness signature of the recipient | `permit.nonce` must equal `intent.nonce`; Permit2 consumes it |
| `changeRangeWithSignature`, `exitWithSignature` | the position's current owner | EIP-712 `RelayedPositionAction` signed by that owner | `intent.nonce`, consumed in the zap's bitmap |

**Plain path.** The owner sends the transaction:
- ERC-20 inputs come from `msg.sender` through an ERC-20 allowance to the zap; native comes as `msg.value`, which must equal the native inputs.
- Smart wallets and EIP-7702 accounts whose delegate cannot sign Permit2 permits use this path (F0).
- The zap pulls only from `msg.sender`, so an allowance left on the zap serves nobody else.

**Permit2 path** (one signature, any wallet):
- The signer is `intent.recipient`, which receives the NFT and the refunds. A create paid by one account for another uses the plain path.
- `permit.permitted` must be exactly `plan.inputs`, in order, ERC-20 only. The interface's permit functions are not payable, so native ETH comes through the plain path.
- The owner needs Permit2's one-time ERC-20 approval, which most wallets that used Uniswap already have.
- Typed data, Permit2's domain (`api-contracts/v2/eip712.json`, `permit2`):

```json
{
  "domain": { "name": "Permit2", "chainId": 4663, "verifyingContract": "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  "primaryType": "PermitBatchWitnessTransferFrom",
  "types": {
    "PermitBatchWitnessTransferFrom": [
      { "name": "permitted", "type": "TokenPermissions[]" }, { "name": "spender", "type": "address" },
      { "name": "nonce", "type": "uint256" }, { "name": "deadline", "type": "uint256" },
      { "name": "witness", "type": "PositionIntent" } ],
    "TokenPermissions": [ { "name": "token", "type": "address" }, { "name": "amount", "type": "uint256" } ],
    "PositionIntent": "… as eip712.json types.PositionIntent …",
    "PoolRef": "… as eip712.json types.PoolRef …"
  },
  "message": {
    "permitted": [ { "token": "<USDG>", "amount": "100000000" } ],
    "spender": "<zap.v4 or zap.v3>",
    "nonce": "<= witness.nonce>",
    "deadline": "<unix seconds>",
    "witness": { "action": 1, "pool": { … }, "tokenId": 0, "…": "…", "recipient": "<the signer>", "nonce": "<= nonce>" }
  }
}
```

**Relayed path** (change range and exit; nothing is pulled):
- The position's owner signs a `RelayedPositionAction` on the Domino domain (`name` Domino, `version` 2, the chain id, the zap as `verifyingContract`). Anyone may submit it.
- The NFT must already be approved to the zap: by a transaction, or by the position manager's own `permit`, which a relayer can submit first.
- Typed data:

```json
{
  "domain": { "name": "Domino", "version": "2", "chainId": 8453, "verifyingContract": "<zap>" },
  "primaryType": "RelayedPositionAction",
  "types": {
    "RelayedPositionAction": [
      { "name": "intent", "type": "PositionIntent" }, { "name": "liquidityToRemove", "type": "uint128" },
      { "name": "amount0MinRemoved", "type": "uint128" }, { "name": "amount1MinRemoved", "type": "uint128" },
      { "name": "amount0Max", "type": "uint128" }, { "name": "amount1Max", "type": "uint128" },
      { "name": "burn", "type": "bool" } ],
    "PositionIntent": "…", "PoolRef": "…"
  },
  "message": { "intent": { "action": 4, "…": "…" }, "liquidityToRemove": "…", "amount0MinRemoved": "…",
               "amount1MinRemoved": "…", "amount0Max": "0", "amount1Max": "0", "burn": true }
}
```

  An exit signs both caps as zero; `burn` is the plan's `burn` (exit) or `burnOld` (change range). The signature is 65 bytes with a low `s` (EIP-2); the zap has no EIP-1271. A smart-wallet owner uses the plain path.

**The intent's fields, per action:**

| Field | create | increase | change range | exit |
| --- | --- | --- | --- | --- |
| `action` | 1 | 2 | 3 | 4 |
| `pool` | the target pool | the position's pool | the position's pool (the new range is in it) | the position's pool |
| `tokenId` | 0 | the position | the old position | the position |
| `tickLower`, `tickUpper` | the new range | **the position's range** | the new range | **the position's range** |
| `minLiquidity` | liquidity minted, at least | liquidity added, at least | new position's liquidity, at least | `liquidityToRemove` must be at least this |
| `feeBps`, `feeToken` | 65 and F1b's selection with legs; 0 and `address(0)` without | ← | ← | ← |
| `routesHash` | `keccak256(abi.encode(legs))` | ← | ← | ← |
| `recipient` | NFT and refunds | refunds (v4: with the accrued fees) | new NFT and refunds | everything withdrawn |

**The intent hash.** Every receipt event and `FeeCharged.ref` carry `intentHash`, the EIP-712 digest of the `PositionIntent` on the Domino domain with this zap as `verifyingContract`. It is the same in all three paths.

## The net minimum

- **Create, increase, change range.** `intent.minLiquidity` bounds the liquidity the owner gets.
  - The zap sizes the addition from the amounts it holds (F1c's amount-driven sizing, #282 A2/B3).
  - Moving the price either way lowers `min(L0, L1)` of a balanced plan, so a tight minimum also bounds price manipulation. A sandwich, or a pool someone initialized first at another price (A11), makes the action revert instead of minting at a bad price (`testCreateInitializesAPoolOnlyIfItHasNoPrice`).
  - The unsigned parts of a permit plan (`amount0Max`, `amount1Max`, `initSqrtPriceX96`) can only lower the liquidity, which the minimum refuses.
- **Each swap leg.** The signed `minAmountOut` is checked on what arrives (F1b).
  - An output fee comes out of the delivered amount, so the owner's net is at least `minAmountOut − 65 bps` of it.
  - An input fee comes on top of `amountIn`.
- **Exit.** The removal minima bound the principal; on the relayed path they are signed.
- **Conversion legs spend exactly their signed `amountIn`.** The planner sets it at or below the expected withdrawal, and the rest of that token is refunded as is. An exit "to one token" can therefore return dust of the other. Spending "everything withdrawn" would need a leg kind F1b does not have.

## Tokens, refunds and allowances

- **Pulls.** Only from `msg.sender` (ERC-20 `transferFrom`, native as `msg.value`) or through Permit2 from the signer.
  - Tokens that return no data work.
  - An address without code is refused.
  - The amount pulled is the amount the plan names.
- **Native.**
  - v4 uses `address(0)`.
  - v3 pools hold WETH9, the `WETH9()` of the chain's NonfungiblePositionManager. Native ETH, sent with the call or delivered by a leg, is wrapped before it is added to a WETH pool. What is left of it comes back as WETH. Native held for any other pool comes back as ETH.
  - The zap's `receive` accepts ETH only inside an action. Stray ETH is refused.
- **Refunds.**
  - Every token the action touched goes to the recipient in the same transaction.
  - The touched set is native, the pool currencies, the inputs and the legs' outputs. A leg's input is always one of these.
  - Stray tokens of those kinds go along.
  - Owed fees never do.
- **Allowances.** None survive:
  - the executor grants and checks exact ERC-20 and Permit2 allowances per router leg (F1b);
  - F1c's v3 steps reset the manager's allowances to zero;
  - the v4 steps use none.
- **Fees.** `FeeCharged(1, token, owner, amount, intentHash)`.
  - If the recipient cannot receive, the fee is owed (`FeeDeferred`), the action completes, and anyone can `flushOwedFees` later (F1b).
  - An owed native fee is never wrapped (v3).

## The v4 approval that stays

INCREASE, DECREASE and BURN on v4 need the zap approved on the NFT. The approval survives the action, and the approved zap cannot clear it. On v3 an approval also stays after a change of range or exit that does not burn. So every entry point authorizes the position's current owner itself:
- plain path: `msg.sender == ownerOf(tokenId)`;
- Permit2 path: `intent.recipient == ownerOf(tokenId)`, plus Permit2's check of the signature;
- relayed path: the signature recovers to `ownerOf(tokenId)`.

A transfer of the NFT clears the approval and voids the old owner's relayed signatures (`testAfterATransferTheOldOwnersSignatureIsVoid`). The owner can revoke the approval at the position manager at any time. The app should show it as "Domino can manage this position for you when you ask".

## Hooks policy

`DominoZapV4.HOOKED_POOLS_ALLOWED` is `false`: an action on a v4 pool whose `hooks` is not zero reverts `InvalidPlan` before anything moves. This applies to positions only.
- Swap legs may cross hooked pools either way, and F1b judges them by what arrives (#282: "hook só no trecho de swap").
- Accepting hooked pools is that constant set to `true`. F1c settles hook deltas by their actual amounts, bounded by the minima.
- With hooks accepted, a v4 increase's fee credit is no longer exactly `delta + principal`. That changes only how the app reads the receipt.

`hookedPoolsAllowed()` exposes the policy to the app.

## Resuming after an interruption

Each action is one atomic transaction, so an interruption leaves nothing half done. The app resumes by reading on-chain state:

| Interrupted at | What remains | How the app resumes |
| --- | --- | --- |
| After an approval (ERC-20 to the zap or Permit2, NFT to the zap) | the approval | continue with the action |
| After signing, before sending | a valid signature until `deadline` | submit it; check `Permit2.nonceBitmap` / `zap.nonceBitmap` to see whether it was used |
| The plan went stale (price moved) | nothing moved: the transaction reverted on `minLiquidity` or a leg's minimum | re-plan and sign with a new nonce; void the old one with `Permit2.invalidateUnorderedNonces` or `zap.invalidateNonces` |
| A transaction stuck past its deadline | nothing | `PlanExpired` if it lands late |

`testAStalePlanMovesNothingAndAFreshOneCompletes` runs the stale-plan row end to end.

## The receipt

The events of one action tell the whole story without guesswork or prices:

| Event | Emitter | What |
| --- | --- | --- |
| `InputPulled(intentHash, owner, token, amount)` | zap | each input (native is `address(0)`) |
| `SwapLegExecuted(kind, tokenIn, tokenOut, venue, amountIn, amountOut)` | zap (F1b) | each leg, measured; with the pool's fee tier from the leg's path, this is the pool cost |
| `FeeCharged(1, token, owner, amount, intentHash)`, `FeeDeferred(token, amount, totalOwed)` | zap (F1b) | the tariff, paid or owed |
| `PositionLiquidityChanged(intentHash, owner, tokenId, pool, liquidityDelta, amount0, amount1)` | zap | each position step: `liquidityDelta` > 0 added, < 0 removed, 0 collected; amounts < 0 paid into the pool, > 0 taken out (principal and fees; a v4 increase nets the accrued fees) |
| `Refunded(recipient, token, amount)` | zap (F0) | everything returned |
| `PositionActionExecuted(action, recipient, tokenId, previousTokenId, liquidity, intentHash)` | zap (F0) | the summary; `previousTokenId` is 0 for create, the position for increase and exit, the old position for change range |

The pool sits in the step event because a burned NFT can no longer be read. `ActionResult` returns the main step's token id, liquidity and amounts (as magnitudes), plus the fee token and amount.

## Failure modes

| Error | When |
| --- | --- |
| `InvalidPlan()` | Wrong action. A recipient that is zero or the zap. A pool of the other dex, a hooked v4 pool, or v3 hooks set. `routesHash` does not match the legs. A create with a `tokenId`. Increase or exit ticks that are not the position's range. `msg.value` that is not the native inputs. A permit with another nonce, another token or amount, or a native input. Also F1b's leg errors. |
| `PlanExpired()` | `block.timestamp > intent.deadline`. |
| `Unauthorized()` | Plain or Permit2 path by someone who does not own the position. Stray ETH. An unlock callback not from the PoolManager or not for the pending step. F1b's callback errors. |
| `InvalidSignature()` | Relayed signature not 65 bytes, a high `s`, or one that does not recover to the position's owner. Any change to a signed field also lands here. |
| `NonceUsed(owner, nonce)` | Relayed nonce already used or invalidated. |
| `InsufficientLiquidity()` | Exit removing less than `intent.minLiquidity`. |
| `FeeMismatch()`, `SwapEffectMismatch()` | F1b: fee terms, or a leg's effect. |
| F1c's `InsufficientLiquidity(l, min)`, `PartialBurn`, `PositionPoolMismatch`, `InvalidPool`, `InvalidRange`, `InvalidRecipient`, `PoolNotInitialized` | the position steps |
| Permit2's `InvalidSigner`, `InvalidNonce`, `SignatureExpired`, `InsufficientAllowance` | the Permit2 path, or a router pulling more than its leg |
| Uniswap's `NotApproved(zap)` (v4) and `Not approved` (v3) | the zap is not approved on the NFT |
| `TokenCallFailed(token)` | a pull without allowance, or a token that fails |
| `DominoZapV4Steps.DirectCall()`, `DominoZapV4.InvalidZapConfig()` | the steps called directly; a steps address without code at construction |

## Sizes and gas

Solidity 0.8.26, via-IR, 200 runs, Cancun, `bytecode_hash = none`:

| Contract | Runtime | Left of 24,576 |
| --- | ---: | ---: |
| `DominoZapV4` | 20,732 B | 3,844 B |
| `DominoZapV4Steps` | 7,394 B | 17,182 B |
| `DominoZapV3` | 23,135 B | 1,441 B |

How the size was found:
- With the F1c v4 adapter compiled into the zap, `DominoZapV4` came to 27.1 KB. The adapter is about 6 KB, F1b's executor about 5.3 KB, and the plans' ABI decoding about 4 KB.
- Moving the adapter's steps behind DELEGATECALL was the only cut large enough. The steps contract has no state and no configuration, so the same bytes deploy to the same CreateX address on every chain.
- The v3 adapter is small enough to stay inline.
- Two compiler facts:
  - the four plans share one body because the action and the consent path travel in memory: the Yul optimizer's FunctionSpecializer copied a body called with literal arguments once per entry point, which made the zap 45–52 KB;
  - the relayed typehash is a literal (pinned in `DominoV2Types.t.sol`), because the optimizer does not fold the concatenated type string.
- `DominoZapBase._act` sits close to via-IR's stack limit. Some edits that *remove* code there fail with "Variable … too deep in the stack": deleting the addition's record, or the sign test in `_magnitude`. Expect a change there to need a local struct or a split.

Gas, measured inside the suites on the bytecode deployed on Base (`testGasPerFlow`, `testGasPerFlowOnV3`). Each figure is one call, with the plan's legs in a deep pool. It includes the swap, the fee transfer, the refunds and the first touch of the position's storage. It excludes the 21,000 base and calldata. These are indicative: measure on the target chain before setting limits.

| Flow | v4 | v3 |
| --- | ---: | ---: |
| create, one swap, plain (first position, cold ticks) | 610k | 775k |
| create, one swap, Permit2 witness | 466k | — |
| increase, one swap (v4: fees netted in) | 228k | 264k |
| change range, no swap, burn old | 404k | 644k |
| exit to one token (one conversion), burn | 246k | 291k |

On top of F1c's steps (`docs/v2/F1_POSITIONS.md`), the zap adds:
- the plan checks and the intent hash (two keccaks of the plan);
- one `balanceOf` per touched token per leg, from F1b;
- one transfer per refunded token;
- the receipt events;
- on v4, a DELEGATECALL per step (about 3k).

## Deterministic deployment

Each component goes through CreateX `deployCreate3` (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`, all three chains), with salt `deployer ‖ 0x00 ‖ bytes11(keccak256("domino.v2.<component>"))` (F0):

| Component | `bytes11(keccak256("domino.v2.<component>"))` | Constructor |
| --- | --- | --- |
| `zap.v4.steps` | `0x59f2325f7d67f7038cd06d` | none, identical init code on every chain |
| `zap.v4` | `0xec60e889c6bd24495f213d` | `(RouteConfig route, address positionManager, address steps)` |
| `zap.v3` | `0xbddaa2c68dd90d5da7fd75` | `(RouteConfig route, address positionManager)` |

Order of deployment:
1. `registry` (F1a);
2. `zap.v4.steps`;
3. `zap.v4` and `zap.v3`.

`RouteConfig = (registry, permit2, v3Factory, v3PoolInitCodeHash, v4PoolManager)` (F1b):
- the registry is the `registry` component's CREATE3 address;
- Permit2 is `0x000000000022D473030F116dDEE9F6B43aC78BA3` everywhere;
- the init code hash is `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54` everywhere.

Both zaps take the full route, so each can swap through v3 pools, v4 pools and the admitted Universal Router.

| Chain | v3 factory | v3 NonfungiblePositionManager | v4 PoolManager | v4 PositionManager |
| --- | --- | --- | --- | --- |
| Robinhood 4663 | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| Base 8453 | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | `0x7C5f5A4bBd8fD63184577525326123B519429bDc` |
| Arbitrum 42161 | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32` | `0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869` |

The constructors check:
- the route (F1b: code at the registry, Permit2, factory and PoolManager);
- that the position manager belongs to the factory or PoolManager (F1c `checkManagers`);
- v4 only: code at the steps address.

The registry must admit Universal Router 2.1.2 (`REGISTRY_ROUTER`, version 212) and rank the charge currencies (USDG/USDC 1, ETH and WETH 2) before the zap can take router legs or charge in them.

## Evidence

Four suites, one at a time with `node scripts/test-contracts.mjs --match-path test/v2/zap/<Suite>.t.sol`:

| Suite | Tests | Stack | What it pins |
| --- | ---: | --- | --- |
| `ZapV4Deployed.t.sol` | 44 | the v4 PoolManager and PositionManager **bytecode deployed on Base** (F1c fixtures), Robinhood's Permit2 | the four flows, native ETH, fees forwarded on increase, the lingering approval, intent binding, Permit2 and relayed signatures (signer, zap, chain, witness, nonce, deadline, malleability, length), a frozen or rejecting fee recipient, reentry by a token, a swap hook and a recipient, callbacks, constructor, resumption, gas |
| `ZapV4Vendored.t.sol` | 43 | the same behaviour on the vendored v4 sources | the same |
| `ZapV3.t.sol` | 15 | the v3 factory, NonfungiblePositionManager and WETH9 **bytecode deployed on Base**; pools from the etched factory; v3 legs | the four flows, WETH wrapping (and none for other pools), an owed ETH fee never wrapped, increase open on v3 but owner-only here, approval, relayed exit, pool validation, initialization, constructor, gas |
| `ZapRouters.t.sol` | 11 | **Robinhood's Universal Router 2.1.2, Permit2 and v4 PoolManager runtimes**; the vendored PositionManager on that PoolManager; F1b's scripted router | a create through the real router (allowances closed), and router calldata that swaps more. A router that takes more, returns less, leaves part of the input or an allowance, sends ETH along, calls back, or is not admitted. A fake PoolManager that forwards the callback |

The suites re-use the F1b/F1c test kits and fixtures, add none, and deploy the zaps from their artifacts, so editing a test does not recompile them. The F0, F1b and F1c suites were re-run on this branch after the stack merge.

**Mutation.** `contracts/mutations/v2-zap-2026-10-02.json` deletes or weakens every guard of `src/v2/zap`, one at a time, against the suite meant to catch it: **75 of 75 caught**, plus one mutant expected to survive, which says why (de-duplicating the refund list only saves gas). How the score was reached:
- The full run of 76 caught 72.
- Two mutants that deleted code did not compile (via-IR stack-too-deep, see [Sizes and gas](#sizes-and-gas)) and were replaced with mutants that compile.
- One, a failed pull that does not revert, survived: the leg failed later with the same error. Its test now leaves a stray balance in the zap, so the mutant would complete the action with someone else's tokens.
- Those three were re-run on the final tree and are caught.

Every mutant was first checked to compile.

Checks that could never be the deciding one were removed rather than kept unpinned, as F1b did:
- a zero-signer check, since the owner comes from `ownerOf` and is never zero;
- a permit-length check, which Permit2 enforces;
- clearing the pending unlock hash, since every unlock the zap makes sets it first and only the PoolManager calls back;
- a leg's input in the refund list, since it is always already there.

To run the batch, seed a `mutate-contracts.mjs` sandbox with this checkout's `contracts/cache` and `contracts/out`, then call `runBatch` (F1c's note).

**solc-js limit.** One forge job crashes in under a second (`RuntimeError: memory access out of bounds`) when its standard-JSON input exceeds about 1.3 MB, whatever the code. Forge sends every dirty file in one job, together with the closure of the matched suite.
- Measured: 1,251,335 bytes passed and 1,351,426 failed.
- An F0 change dirties every V2 source, so after one, compile in stages, for example a small suite first with the rest parked.
- The four zap suites together need about 1.05 MB, which is why the Base fixture helper lives in its own file.
- All V2 suites together need about 1.39 MB, and F1b and F1c together about 1.20 MB. With #292 and #291 on main, this branch's CI compile, restored from main's cache, holds only the zap's closure. That is also why the new EIP-712 type is not in `DominoV2Types.sol`.

## F0 changes (additive)

- `DominoV2RelayTypes.RelayedPositionAction`, with its type string, typehash and `hashRelayedPositionAction`, in a new file beside `DominoV2Types.sol`. `scripts/v2/eip712_exports.py` reads both files. The exports were regenerated: `eip712.json`, `eip712-goldens.json` (eth_account) and `DominoV2Goldens.sol`. `DominoV2Types.t.sol` and `backend/tests/test_v2_eip712_exports.py` pin the typehash, the nesting and the digest.
- `DominoV2Types.sol` itself is unchanged. Changing it would make every V2 source dirty, and the whole V2 tree is past what one solc-js job compiles (see [solc-js limit](#evidence)).
- `IDominoZap`: `changeRangeWithSignature`, `exitWithSignature`, `nonceBitmap`, `invalidateNonces`, `positionManager`, `hookedPoolsAllowed`, the events `InputPulled`, `PositionLiquidityChanged`, `NoncesInvalidated`, and the errors `InvalidSignature`, `NonceUsed`. The ABI exports and the interface-id pin test were regenerated.
- A new CreateX component, `zap.v4.steps`.

Nothing existing changed: the other ABI files, type strings, typehashes and goldens are as they were.

### Relayed actions and the F0 addition

F0 describes the `PositionIntent` as "a direct EIP-712 signature when a relayer submits an action that pulls nothing". But the intent does not bind:
- the plan's removal minima (`amount0MinRemoved`, `amount1MinRemoved`);
- `liquidityToRemove`;
- the caps;
- the burn flag.

A relayed exit signed over the intent alone could therefore be submitted with zero minima and sandwiched. A relayer, or anyone holding the signature, could do it. `RelayedPositionAction` nests the intent with those fields, so the wallet shows the minima and nothing the owner gives up is unsigned. The plain and Permit2 paths are unchanged: their unsigned fields can only lower liquidity, which `minLiquidity` refuses.

## Owner decisions (2 October 2026)

The owner accepted each recommendation below as implemented. The tariffs are in PRICING_POLICY.md, section V2.

1. **Relayed actions sign `RelayedPositionAction`, not the bare `PositionIntent`.** This closes the sandwich gap above.
2. **Hooked v4 pools are refused for positions by default.** Accepting them stays one constant (see [Hooks policy](#hooks-policy)).
3. **Refunds go to `intent.recipient`**, as F0 says. On the Permit2 path the recipient is the signer, so it is the owner. On the plain path the caller chooses it.
4. **No native ETH on the one-signature path.** F0's permit functions are not payable. ETH-only or ETH-plus-approved-token creates use the plain path.
5. **Exit dust goes back to the owner.** A conversion leg spends exactly its signed `amountIn` (F1b), and the unconverted remainder is refunded, uncharged.
