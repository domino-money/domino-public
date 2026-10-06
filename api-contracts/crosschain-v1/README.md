# crosschain-v1: deposit from another chain

Contract `1.1.0-rc.1` for S2 of [#283](https://github.com/domino-money/domino/issues/283): the user bridges to their own wallet on Robinhood (4663), Base (8453) or Arbitrum One (42161) through Relay or Across, paying the provider's 35 bps app fee, and then creates the position with S1. The flow, the configuration and the operations are in [docs/v2/F5_BRIDGE.md](../../docs/v2/F5_BRIDGE.md).

POST `/api/crosschain/v1/<route>` through the authenticated bridge (private origin `/internal/crosschain/v1/<route>`, `backend/crosschain_api.py`), with `X-Domino-Crosschain-Contract: 1.1.0-rc.1`, a SIWE session and CSRF. The owner is always the session's wallet: it is the depositor, the recipient on the destination and the refund address. No request can name an owner, recipient, refund address or fee recipient.

| Route | Request | Answer |
| --- | --- | --- |
| `origins` | `destinationChainId`, `destinationToken` (a charge currency of that chain: its stable, ETH `0x0…0` or WETH) | EVM origin chains and tokens each provider can bridge from, per provider; chains whose contracts are not pinned are left out |
| `quote` | `originChainId`, `originToken`, `destinationChainId`, `destinationToken`, `amountKind`, `amountRaw`, `maxInputRaw`, `slippageBps` (10–500), `destinationGas` | Both providers' candidates, the decision and the unsigned wallet steps |
| `status` | `provider`, `originChainId`, `destinationChainId`, `depositTxHash`, `requestId` (Relay only), `previousState` | The deposit's state, recovery path and the app fee measured |

## quote

The amount is asked one of two ways (`amountKind`, required):

| `amountKind` | `amountRaw` | `maxInputRaw` |
| --- | --- | --- |
| `exact_input` | what leaves the wallet, in origin token units | `null` |
| `output` | the least that must arrive in the user's wallet after every fee, in destination token units | the most the wallet may send (its sendable balance), in origin token units |

Both raws are below 2^128. `maxInputRaw` is a required key, `null` exactly when the request is `exact_input`.

- `candidates`: always Relay then Across. `status` is `quoted`, or priced but not eligible: `destination_gas_unsupported` (cannot deliver the destination gas asked for) or `input_above_max` (by output, its deposit needs more than `maxInputRaw`). Otherwise it says why there is no price: `no_route`, `amount_too_low`, `amount_too_high`, `rate_limited`, `unavailable`, `rejected` (the provider refused), `unsafe` (the answer failed Domino's checks; `reason` names the check) or `origin_not_supported`. Destination gas is judged first: a candidate that cannot deliver it is `destination_gas_unsupported`, above the cap or not.
- A priced candidate shows:
  - `inputRaw`: exactly what its deposit takes from the wallet on the origin. It is the request's `amountRaw` in `exact_input`; by output it is the provider's, at most `maxInputRaw` for a `quoted` candidate.
  - `outputRaw` (expected amount in the user's wallet, after every provider fee and the app fee) and `minimumOutputRaw`. By output, every priced candidate's `minimumOutputRaw` is at least `amountRaw`: what must arrive is guaranteed, not only expected.
  - `appFee` (Relay charges it in the input token on the origin; Across in the delivered token on the destination), `providerFee`, `originGas` (provider estimate, may be null), `destinationGas.deliveredRaw` (Relay top-up), `etaSeconds`, `refund` (always the user on the origin chain) and `tracking.requestId` (Relay).
- `decision`: among the `quoted` candidates, the better rate: the higher `outputRaw` per unit of `inputRaw`, compared exactly (`E_a·I_b` against `E_b·I_a`). Ties go to the smaller `inputRaw`, then the lower `etaSeconds`, then Relay. In `exact_input` both inputs are the amount asked, so this is the higher `outputRaw`. `reason` is `best_output`, `only_quote` or `no_quote`.
- `comparison`: `basis` is `expected_output_per_input_after_all_fees`. `advantageRaw` is the extra output the winner delivers for the other's input, `floor(E_w·I_o / I_w) − E_o`, and `advantageBps` is `(E_w·I_o − E_o·I_w) · 10000 // (E_o·I_w)`; both are null without a second `quoted` candidate. In `exact_input` they are `E_w − E_o` and that margin in bps of `E_o`. `runtime.mjs` recomputes all of this.
- `steps`: for an ERC-20, `approval` (exact: the winner's `inputRaw`; skip it when `allowance(owner, spender)` already covers its `amountRaw`), then `deposit`; for the native token, `deposit` alone, whose value is the winner's `inputRaw`. Every transaction is on `originChainId`; the deposit goes only to the provider's pinned contract for that chain (Relay Depository; Across SpokePool, or SpokePoolPeriphery for native ETH). Send them from the session's wallet, in order, before `expiresAt` (120 s); re-quote after that. Without a decision there are no steps.
- `destinationGas: true` asks for native gas on the destination with a non-native delivery. Only Relay's top-up provides it; Across is then `destination_gas_unsupported`. By output, Relay adds the top-up's cost to the input; what arrives stays whole.

### By output

- **Relay** is asked `EXPECTED_OUTPUT` for the need grossed up by the user's slippage, `ceil(amountRaw × 10000 / (10000 − slippageBps))`. The minimum its solver signs is the expected amount less the slippage, so it covers the need exactly. Never `EXACT_OUTPUT`.
- **Across** is asked `minOutput` for the need: an exact-input deposit whose input Across pads, so that at least the need arrives net of Domino's fee. The surplus is drained to the user with the rest. Never `exactOutput`, by either kind of request.
- Relay's app fee is the amount Relay computes by output, 35 bps of the net amount: `floor((input − relayer fee) × 35 / 10035)`. The label is still "Domino fee 0.35%".
- With both candidates `input_above_max` there is no decision: the answer still shows what each would take.

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

## Versions and the switch window

This package carries one version, and so do the Worker (`bridge/src/crosschain-worker.mjs`) and the app (`app/src/v2/crosschain/version.ts`), which import it: each asks and accepts exactly `1.1.0-rc.1`.

The listener also answers `1.0.0-rc.1` for a switch window (the owner's option A, 6 Oct 2026):
- The request's header names the version, and the answer, its header and the request's `hop_log` line carry that version.
- A `1.0.0-rc.1` request is held to the frozen copy of that contract's models (`backend/crosschain_models_rc1.py`, byte for byte what main 26e264f7 served) and runs as `exact_input`.
- Its answer is projected back: no `amountKind` or `maxInputRaw` in the echo, no `inputRaw` in the candidates, `basis: expected_output_after_all_fees`, and the fingerprint over rc.1's identity.
- For the same provider answers it is the answer that version served, byte for byte. The test is `backend/tests/test_crosschain_service.py` against `backend/tests/fixtures/crosschain/rc1`.

While the Worker and the app are not yet both on 1.1.0-rc.1, an open page sees S2 locked, as it does for any capabilities version it does not know; no POST fails.

**Dropping 1.0.0-rc.1**, once the listener's request lines show no `"contractVersion":"1.0.0-rc.1"` for a few days:
1. Delete `backend/crosschain_models_rc1.py`, `backend/tests/fixtures/crosschain/rc1` and their tests.
2. Remove `PREVIOUS_VERSION`, `CONTRACT_VERSIONS` and `MODELS`' second entry (`crosschain_models.py`), the projection (`crosschain_service.previous_answer`) and `CONTRACT_VERSIONS` in `crosschain_api.py`. `authenticated_api.py` then serves one version, as for every other family.
3. Regenerate the manifests (`scripts/export-*-contract.py`) and move the app pins they affect.
4. Release the listener (F5_BRIDGE.md, In production).

## Checks

```sh
backend/.venv/bin/python scripts/export-crosschain-contract.py --check
node --test api-contracts/crosschain-v1/consumer.test.mjs
```

`backend/tests/test_crosschain_contract.py` runs both, and holds the Python and browser validators to the same verdict on every fixture, variant and tampered answer. The fixtures are produced by the real service over recorded provider answers with synthetic wallets (`0x1111…` the user, `0x2222…` the fee recipient). The variants `quote.output`, `quote.output-above-max` and `quote.output-native` are quotes by output over the live answers of 6 Oct 2026.
