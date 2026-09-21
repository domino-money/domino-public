# Owner-funded setup and sequence controls

The wallet build exposes `#/setup` and `#/sequence`. Connecting a wallet or
signing in does not approve a token, fund an operation, create a sequence, or
start execution. Each financial step is built from the local typed ABI,
simulated, shown with amounts/fees/gas limits, and offered once only after the
owner checks that review and clicks its wallet-send control.

## Deployment identities

`GET /api/setup/v1/release` supplies the public DominoSetup deployment and its
four code hashes, immutable managers, fee recipient, tariff and expiry.
`GET /api/setup/v1/sequence-release` supplies the V4 factory, implementation,
helpers, execution engine, routing, price guard, fixed operator and price
publisher, and ten code hashes including the EIP-1167 clone template. The
wallet checks deployed code and immutable links before preparing authority.
The Worker publishes `available:false` until those actual deployments exist.
These documents contain no private RPC URL, bearer credential or signing key.

## Setup

The ordinary deposit flow uses the existing authenticated deposit contract and
its reviewed owner transactions. The advanced owner flow uses DominoSetup:

1. Load the verified deployment and existing operations through the connected
   wallet. Specify the currencies and pool parameters, raw funding amounts,
   and an explicit gas budget and native reserve.
2. Review exact token approval if needed, then funding. Native currency uses
   the zero address and exact transaction value. No approval for an arbitrary
   spender or unlimited amount is generated.
3. Optionally simulate and review one exact-input swap. Its stated service
   tariff is bounded by the approved 65-bps ceiling and applies to consumed
   gross input; there is no 2% automation charge on owner principal. A
   successful swap cannot be charged or executed twice for that operation.
4. Review mint amounts, liquidity, range, price bounds and deadline. For a new
   pool, initialization and first liquidity are atomic. The NFT goes directly
   to the owner and unused funds are refunded.

Cancelling returns the current operation balances to its owner. After a swap,
that means its remaining inputs and actual output; cancellation never swaps
back or charges again. Cancellation does not need a Domino session, private
backend, operator, or running executor.

If one token is paused, frozen or otherwise cannot be transferred, call
`recoverCurrency(operationId, currency, amount)` from the operation's owner to
return an available currency independently. The currency must be one of that
operation's two currencies; the nonzero raw amount cannot exceed its remaining
balance. Native currency uses the zero address. Recovery always pays the fixed
owner and charges no service fee. A failed transfer leaves that claim intact.

The first successful partial recovery sets `recoveryStarted(operationId)` and
permanently disables mint and swap for that operation. Read both remaining
balances through the unchanged `operation(operationId)` getter. A restricted
token remains claimable; recover it later when its transfer is available, or
use `cancel` to return all remaining balances together. The operation closes
only once both balances reach zero. Recovery works without the pool manager,
position manager, read dependency or Domino services.

Recovery requires the setup contract's balance to decrease by exactly the
debited claim. It lets the owner accept a transfer tax or forward tokens from a
receipt hook; this does not weaken transfer checks for swap funding, service
fees or minting. `SetupCurrencyRecovered` records the escrow debit and the
owner's actual balances before and after the transfer. Their difference is a
net balance change, not a promise that the owner retained the nominal amount.
The final partial recovery also emits `SetupClosed`; its refund fields cover
only that final transaction. The two events describe the same transfer and
must not be counted twice. Ordinary successful `cancel` keeps its existing
single `SetupClosed` receipt and refund amounts.

## Sequences

A root NFT remains in its owner's wallet. Creation first approves only that
NFT to its locally predicted clone address, then creates a paused sequence
with explicit fee consent and bounded policy. A sequence manages earned fees
and child NFTs. Its 2% service charge applies once to consumed uncharged
fees, including converted lineage; it does not charge principal or already
charged residues again. Creating the sequence does not submit an operator
execution. A separate activation review requires a current verified release,
the admitted operator, valid root permission and the same policy/limit versions.
Its guard is repeated before the wallet request; an offline recovery profile
cannot activate automation.

Owner controls read the exact registered clone and owner on chain. Pause,
operator revocation, individual root-approval revocation, child withdrawal and
fee-reserve withdrawal are separate reviewed wallet actions. Existing verified
public deployment profiles can be retained for recovery when the public
release or Domino services are unavailable. Expired profiles cannot prepare
new approvals or creation.

## Ambiguous wallet outcomes and receipts

There is no automatic resend. A shared browser journal claims each chain,
owner and nonce under a cross-tab lock before it reaches the wallet. It
persists only a hash and random claim ID, never the address, transaction,
amounts, session or API response. A definite wallet rejection (4001), including
one that arrives after a UI timeout, releases only its exact claim. A timeout,
unknown error or late transaction hash keeps the claim in quarantine.

Check wallet activity and on-chain operation/sequence state after an uncertain
result. Reloading never turns an uncertain nonce into a new offer. Setup
receipts must match the reviewed transaction, or a typed owner operation
explicitly recovered after reload. Sequence receipts are bound to that
session's actual review; after reload the owner independently reads sequence
state instead of labeling an unrelated pasted hash as confirmation. A receipt
is complete only after its block is canonical and finalized.

The browser journal is bounded at 1,024 entries and currently retains consumed
claims. Reaching that limit stops new offers. It is a known pilot limitation;
do not clear uncertain entries or browser storage to force another send.

## Qualification evidence

Disposable official Uniswap v4 contracts exercise ERC-20 and native setup,
swap/mint/cancel, contract-wallet refunds with nonempty return data, fee-once
accounting, owner isolation, exact reviews, chain/account changes, canonical
receipts and ambiguous/rejected wallet responses. The sequence SDK is also
exercised against real local EVM transactions. These tests do not claim a
funded mainnet deployment, live private session or an actual-wallet trial.
Focused setup recovery tests additionally cover independent currency claims,
restricted tokens, tax receipts, excessive debits, unavailable dependencies,
cross-owner isolation and token/owner callback reentrancy.
