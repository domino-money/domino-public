# crosschain-v1: deposit from another chain

Contract `1.0.0-rc.1` for S2 of [#283](https://github.com/domino-money/domino/issues/283): the user bridges to their own wallet on Robinhood (4663), Base (8453) or Arbitrum One (42161) through Relay or Across, paying the provider's 35 bps app fee, and then creates the position with S1. The flow, the configuration and the operations are in [docs/v2/F5_BRIDGE.md](../../docs/v2/F5_BRIDGE.md).

POST `/api/crosschain/v1/<route>` through the authenticated bridge (private origin `/internal/crosschain/v1/<route>`, `backend/crosschain_api.py`), with `X-Domino-Crosschain-Contract: 1.0.0-rc.1`, a SIWE session and CSRF. The owner is always the session's wallet: it is the depositor, the recipient on the destination and the refund address. No request can name an owner, recipient, refund address or fee recipient.

| Route | Request | Answer |
| --- | --- | --- |
| `origins` | `destinationChainId`, `destinationToken` (a charge currency of that chain: its stable, ETH `0x0…0` or WETH) | EVM origin chains and tokens each provider can bridge from, per provider; chains whose contracts are not pinned are left out |
| `quote` | `originChainId`, `originToken`, `destinationChainId`, `destinationToken`, `amountRaw` (exact input), `slippageBps` (10–500), `destinationGas` | Both providers' candidates, the decision and the unsigned wallet steps |
| `status` | `provider`, `originChainId`, `destinationChainId`, `depositTxHash`, `requestId` (Relay only), `previousState` | The deposit's state, recovery path and the app fee measured |

## quote

- `candidates`: always Relay then Across. `status` is `quoted`, `destination_gas_unsupported` (priced, but cannot deliver destination gas), or why there is no price: `no_route`, `amount_too_low`, `amount_too_high`, `rate_limited`, `unavailable`, `rejected` (the provider refused), `unsafe` (the answer failed Domino's checks; `reason` names the check) or `origin_not_supported`.
- A priced candidate shows `outputRaw` (expected amount in the user's wallet, after every provider fee and the app fee), `minimumOutputRaw`, `appFee` (Relay charges it in the input token on the origin; Across in the delivered token on the destination), `providerFee`, `originGas` (provider estimate, may be null), `destinationGas.deliveredRaw` (Relay top-up), `etaSeconds`, `refund` (always the user on the origin chain) and `tracking.requestId` (Relay).
- `decision`: the quoted candidate with the higher `outputRaw`; ties go to the lower `etaSeconds`, then Relay. `comparison.advantageRaw`/`advantageBps` is the winner's margin over the other quoted candidate. `runtime.mjs` recomputes all of this.
- `steps`: for an ERC-20, `approval` (exact amount; skip it when `allowance(owner, spender) >= amountRaw`), then `deposit`; for the native token, `deposit` alone. Every transaction is on `originChainId`; the deposit goes only to the provider's pinned contract for that chain (Relay Depository; Across SpokePool, or SpokePoolPeriphery for native ETH). Send them from the session's wallet, in order, before `expiresAt` (120 s); re-quote after that.
- `destinationGas: true` asks for native gas on the destination with a non-native delivery. Only Relay's top-up provides it; Across is then `destination_gas_unsupported`.

## status

Poll after the deposit is sent, every `nextCheckSeconds`, until `terminal`. Pass the last `state` as `previousState`: a provider whose indexer lags cannot move the state back (`transition: "held"`).

| `state` | Meaning | `recovery` |
| --- | --- | --- |
| `awaiting_deposit` | The provider has not seen the deposit yet | – |
| `pending` | Deposit seen, fill in progress | – |
| `filled` | Delivered to the user's wallet (`fillTxHash` on the destination); terminal | – |
| `refund_pending` | Across: not filled before the deadline; the refund to the user on the origin takes hours | `automatic_refund` |
| `failed` | Relay: the fill failed; a refund to the user on the origin follows | `automatic_refund` |
| `refunded` | Refunded to the user on the origin; terminal | `refunded` |
| `refund_failed` | Relay could not refund automatically | `manual_recovery` |

`fee` reports what the provider collected for Domino once the deposit is filled: `measured` (with `evidence`: `relay_requests_v3`, `destination_receipt`, or `provider_record`), `not_collected` (filled without Domino's fee), `pending` or `unavailable` (with a `reason`).

## Checks

```sh
backend/.venv/bin/python scripts/export-crosschain-contract.py --check
node --test api-contracts/crosschain-v1/consumer.test.mjs
```

`backend/tests/test_crosschain_contract.py` runs both. The fixtures are produced by the real service over recorded provider answers with synthetic wallets (`0x1111…` the user, `0x2222…` the fee recipient). The Worker route (`/api/crosschain/v1/`) is not part of this candidate.
