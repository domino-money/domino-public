# Domino V2 — F5: deposit from another chain (S2), backend

S2 of [#283](https://github.com/domino-money/domino/issues/283): a user with funds on another chain bridges them to **their own wallet** on Robinhood (4663), Base (8453) or Arbitrum One (42161) through the Relay or Across API, then creates the position with S1. This front is the backend: quotes, wallet steps, tracking and fee measurement. The screens are F7's; the contract they consume is [`api-contracts/crosschain-v1`](../../api-contracts/crosschain-v1/README.md).

## Owner decisions this implements (1 Oct 2026)

- Only the plain bridge to the user's wallet. There is no Domino bridge contract on any chain and no one-signature flow.
- The 35 bps is the provider's own app fee, a convenience fee:
  - **Relay:** quote parameter `appFees: [{recipient, fee: "35"}]`, in bps of the input. Relay charges it on top of its own fees and credits it to an off-chain USDC app balance that Domino claims.
  - **Across:** `appFee=0.0035` with `appFeeRecipient`. It is charged in the delivered token and paid on the destination, inside the fill.
  - Nothing on-chain enforces it. Anyone can bridge on relay.link, across.to or anywhere else and use Domino with the funds already in the wallet.
- Quotes are requested server-side. Across' production key and integrator id must never reach the browser, and Relay's key is needed for `/requests/v3`.
- Origins: any EVM chain where a provider has a route to the token, listed from the providers. Non-EVM wallets are a later app task.
- Refunds go to the user. Relay gets `refundTo`; Across refunds the depositor on the origin after `fillDeadline`.

## Flow

1. **Origins.** The app asks `origins` for a destination chain and token. The destination token must be one of that chain's charge currencies: its stable (USDG on Robinhood, USDC on Base and Arbitrum), ETH or WETH. The answer lists the EVM chains and tokens each provider can bridge from, merged per chain.
2. **Quote.** The app asks `quote` with the origin chain and token, the destination, the amount, the slippage (10–500 bps) and `destinationGas`. Since crosschain-v1 1.1.0-rc.1 (owner's authorization, 6 Oct 2026) the amount is asked one of two ways (`amountKind`):
   - `exact_input`: `amountRaw` is what leaves the wallet;
   - `output`: `amountRaw` is the least that must arrive in the wallet after every fee, and `maxInputRaw` the most the wallet may send. The backend answers with what each provider's deposit takes.

   The backend then:
   - quotes Relay and Across at once, both with the 35 bps fee;
   - checks every answer (below);
   - picks the better rate for the user;
   - returns the wallet steps for what the winner's deposit takes (`inputRaw`).
3. **Wallet.** The app switches the wallet to the origin chain. It sends the exact `approval`, skipped when the allowance already covers the amount, then the `deposit`. Both come from the session's wallet and must go out before `expiresAt` (120 s); re-quote after that.
4. **Status.** The app polls `status` every `nextCheckSeconds` with the deposit transaction hash (plus Relay's `requestId`) and the last state it showed, until the answer is terminal.
5. **Position.** Once `filled`, the funds are in the user's wallet on the destination, and the app continues with S1 there.

The owner is always the SIWE session's wallet: the depositor, the recipient and the refund address. No request can name an owner, recipient, refund address or fee recipient. An EOA, plain or EIP-7702 delegated, has the same address on every EVM chain, which is what makes "own wallet" well defined. The session checks the account on Robinhood.

### Choosing the provider

- The candidate with the better rate wins: more of the destination token in the user's wallet per unit sent (`outputRaw / inputRaw`). The output is counted after every provider fee and the app fee. Both amounts are exact integers, and the rates are compared exactly (`E_a·I_b` against `E_b·I_a`), never as floats.
- Equal rates go to the smaller input, then to the shorter time estimate, then to Relay.
- In exact input both candidates take the amount asked, so this is the larger output, as before 1.1.0-rc.1. By output the inputs differ: the owner chose the rate over the smaller input (6 Oct 2026). Relay's input is padded by the user's slippage and Across' by about 0.47%, so the smaller input would follow those paddings rather than the fees.
- By output, a quote whose deposit needs more than `maxInputRaw` is `input_above_max`. It is still priced, so the app can say what it would take, but it is never chosen. With both above it there is no decision. Destination gas is judged first: a candidate that cannot deliver the gas asked for is `destination_gas_unsupported`, above the cap or not.
- Origin gas is shown for each but does not decide. Both need the same wallet transactions (an exact approval for an ERC-20, then one deposit), and their gas figures are unverified provider estimates. Across often reports none, since its simulation fails for a wallet without allowance.
- `destinationGas: true` asks for native gas on the destination with a non-native delivery, so the user can create the position without holding ETH there. Only Relay's `topupGas` provides it, about US$2 of ETH taken from the output. By output, Relay adds its cost to the input instead, and the output stays whole. Across has no such option and is then `destination_gas_unsupported`.
- The answer states the comparison: each candidate's input, output and minimum, the app fee and the provider fee with their tokens, origin gas, delivered gas and the time estimate.
  - `advantageRaw` is the extra output the winner delivers for the other's input, `floor(E_w·I_o / I_w) − E_o`.
  - `advantageBps` is `(E_w·I_o − E_o·I_w) · 10000 // (E_o·I_w)`.
  - In exact input they are the output margin and its bps, as before.
  - `runtime.mjs` recomputes the decision and both figures.

**Live comparison by output, 6 Oct 2026** (100 USDG on Robinhood from Base's USDC, 50 bps):

| | Sends | Expected | Guaranteed |
| --- | --- | --- | --- |
| Relay | 100.916974 USDC | 100.502513 USDG | 100 USDG |
| Across | 100.902201 USDC | 100.473291 USDG | 100.473291 USDG |

Relay wins on rate: 14,509 USDG units more for Across' input, 1 bp. The same pair in exact input (100 USDC) also went to Relay, by 13,451 units.

### What is checked before a step reaches the wallet

Every check refuses the whole quote (`status: "unsafe"`, `reason` naming the check). The other provider can still serve the request.

**Relay** (`backend/crosschain_relay.py`). Only protocol v2 deposits into the Depository pinned for the origin chain are admitted:
- `depositNative(user, orderId)` with value = the input, or an exact `approve(depository, input)` then `depositErc20(user, token, input, orderId)`;
- an implicit transfer, a router call, a deposit address or another chain is refused.

Relay is asked `EXACT_INPUT` for an exact input. By output it is asked `EXPECTED_OUTPUT` for the need grossed up by the user's slippage, `ceil(need × 10000 / (10000 − slippageBps))`. The minimum its solver signs is the expected amount less the slippage, so it is then at least the need: asking 100.502513 USDG at 50 bps signed exactly 100 USDG. Relay is never asked `EXACT_OUTPUT`, whose minimum is the expected amount, so any shortfall fails the fill.

The input is the request's amount in exact input. By output the solver computes it, and the signed payment (`paymentDetails.amount`, positive) defines it.

The solver-signed order must:
- pay the user's wallet, in the requested token, on the requested chain;
- carry no destination calls;
- refund only the user;
- take exactly the input, which must be the same in the payment, the order, the summary, the approval and the deposit;
- keep a minimum within the user's slippage;
- by output, price exactly the amount asked (`relay_quote_output_not_requested`) with a signed minimum of at least the need (`relay_quote_minimum_below_request`).

The order id in the calldata must be the order's. The summary Relay shows must match the order. The app fee Relay reports must be in the input token, and within one unit of:
- in exact input, 35 bps of the input;
- by output, what Relay charges there: 35 bps of the net amount, `floor((input − relayer fee) × 35 / 10035)`. Every output answer of 6 Oct 2026 matched it to the unit. It is about 34.86 bps of what is sent, or 34.18 bps with a gas top-up, which stays outside the base. The relayer fee is then part of the rule: it must be there, in the input token on the origin, and no more than the input (`relay_quote_fee_base`). The label stays "Domino fee 0.35%", and the amount shown is Relay's.

**Across** (`backend/crosschain_across.py`). Only plain bridges (`bridgeableToBridgeable`) are admitted:
- for an ERC-20: `SpokePool.deposit` on the origin's pinned SpokePool;
- for ETH: `SpokePoolPeriphery.depositNative`, naming that SpokePool and the origin's WETH.

Across is asked `exactInput` for an exact input. By output it is asked `minOutput` for the need. That answer is an exact-input deposit whose input Across pads, by 0.46–0.50% on the live answers, whatever the slippage sent, so that at least the need arrives net of Domino's fee. The surplus is drained to the user with the rest. The answer's `amountType` must be the one asked.

`exactOutput` is never admitted, by either kind of request. At the same input it pays the user exactly the need, turns the padding into relayer fee (a bridge fee of 551,925 USDC units against `minOutput`'s 75,981, on 6 Oct 2026), and drains the leftovers to Across instead of the user. Its message would also fail the fee and drain checks below.

The input is the request's amount in exact input. By output it is Across' `inputAmount`, positive, which `maxInputAmount` must repeat (`across_quote_input_mismatch`). The depositor must be the user, with that input, the destination chain and the output token (and, for ETH, that input as the deposit's value). Timestamps must sit within the SpokePool's buffers. By output, the guaranteed amount (`minOutputAmount`, which is `expectedOutputAmount`) must be at least the need (`across_quote_minimum_below_request`).

With the app fee, the deposit's recipient is Across' MulticallHandler, pinned per destination. Its message may only:
- pay the fee to Domino's recipient, before anything else leaves (for ETH, after unwrapping WETH);
- drain the rest to the user;
- emit Across' integrator event.

`fallbackRecipient` must be zero, so a failing call reverts the whole fill instead of sending funds elsewhere. The fee must be 35 bps of the deposit's output, matching what the API reports, in either kind of request. The API's unlimited approval is never used: the backend builds an exact one, for the input, to the pinned SpokePool.

**Both:**
- calldata must be the canonical ABI encoding; only Across' short ignored suffix (`0x73c0de`, or `0x1dc0de` + integrator id) may follow;
- the response contract (`crosschain_models.py`, and `runtime.mjs` for the app) checks again that the deposit and approval go only to the pinned contract, on the origin chain, for exactly what the winner's deposit takes (`inputRaw`). It also checks that every priced candidate takes exactly the amount asked in exact input; that by output every priced candidate guarantees at least the amount asked; and that only a quote within `maxInputRaw` is eligible;
- no response may contain a key, RPC URL, integrator id, session or CSRF value.

These checks were each confirmed by deleting them: 42 guards when S2 shipped. Quoting by output added 33 and moved 10 onto the computed input, 75 in all. Each new or changed one was deleted or weakened in turn: 109 mutants over the adapters, the service, the models and runtime, the switch window and the app's own pre-wallet check, and every one failed a test (6 Oct 2026).

The pinned contracts are in [`backend/crosschain_pins.json`](../../backend/crosschain_pins.json):
- Relay's Depository per EVM chain (52), from Relay's `/chains`;
- Across' SpokePool and SpokePoolPeriphery per EVM chain on the Swap API (20), from Across' `deployed-addresses.json`;
- the MulticallHandlers and the event emitter on the three destinations, decoded from live quotes and verified on-chain on 1 Oct 2026 (code hashes in the file).

A live Relay listing that disagrees with a pin drops that chain. A chain without a pin is not quoted (`origin_not_supported`). Adding one is a reviewed change to the file: read the address from the provider's listing, check its code on that chain, commit.

### Tracking and recovery

| Provider status | State | What the user should know |
| --- | --- | --- |
| Relay `waiting`; Across: not indexed yet | `awaiting_deposit` | Across indexes every ~10 s. |
| Relay `depositing`/`pending`/`submitted`/`delayed`; Across `pending` | `pending` | Fills normally take seconds. |
| Relay `success`; Across `filled` | `filled` | Funds are in the wallet on the destination (`fillTxHash`). |
| Across `expired` | `refund_pending` | No relayer filled before `fillDeadline` (2 h after the quote). Across refunds the user on the origin after the next bundle settles: several hours, about 2.5–3 h after the deposit (`recovery: automatic_refund`). |
| Relay `failure` | `failed` | The fill failed. Relay refunds the user on the origin, minus refund gas; nothing if gas exceeds the amount (`automatic_refund`). |
| Relay `failure` with a `refundFailReason` | `refund_failed` | Automatic refund impossible (`manual_recovery`). The user reclaims the deposit at relay.link/withdraw (the keyless `/withdrawals` flow, signed by the depositor). A smart wallet, or a blocked wallet, goes through Relay support. |
| Relay `refund`; Across `refunded` | `refunded` | Back in the wallet on the origin (`refundTxHash`). |

- The app sends the state it last showed as `previousState`. A provider whose indexer lags cannot move the state back: the answer keeps the earlier state with `transition: "held"`.
- `filled` and `refunded` are terminal.
- The fee is never charged on a refund:
  - **Across:** it is paid inside the fill and the refund returns the full input.
  - **Relay:** the collected fee is read per request (`appFees.actual`). Its value on a refunded request should be zero; confirm it with the first real refund.
- A user can be left with the intermediate token only if they stop between steps, for instance after the approval. The approval is exact and spends nothing by itself.

### Fee measurement

On `filled`, `status` reports what the provider collected for Domino:

**Relay**
- `GET /requests/v3?id=<requestId>` (key required) gives `appFees.actual` for Domino's recipient, in the currency Relay charged (`evidence: relay_requests_v3`).
- By output, the fee Relay quotes and collects is the net-based amount, `floor((input − relayer fee) × 35 / 10035)`. So `appFees.quoted` and `actual` read a little under 35 bps of what was sent: about 34.86 bps, or 34.18 with a gas top-up.
- Without a key: `fee.status: unavailable`, `reason: relay_api_key_missing`.
- `/requests/v2` retires on 24 Nov 2026 and is not used.

**Across**
- One `eth_getTransactionReceipt` of the fill on the destination proves it (`evidence: destination_receipt`):
  - the SpokePool's `FilledRelay` for this deposit carries the message's hash;
  - the updated hash, recipient and amount equal the original ones, so no speed-up replaced the message;
  - for an ERC-20, a `Transfer` of exactly the fee goes from the handler to Domino's recipient;
  - a native fee leaves no log, but the fill of this exact message with a zero fallback proves the transfer ran.
- Without a destination RPC, the deposit record from Across' API is the evidence (`provider_record`, with a reason).
- A deposit delivered straight to the user is `not_collected`, for example one edited to drop the fee.

Each settled result is kept in memory, so polling a filled deposit again costs no further RPC call or provider request.

## Configuration and keys

All read by `backend/crosschain_config.py`.

**Secrets** come from the unit's systemd credentials (`LoadCredentialEncrypted=`, read under `$CREDENTIALS_DIRECTORY`) when present, otherwise from the environment. Nothing secret is committed, logged or returned. A bad value stops the listener with the setting's name, never the value.

| What | Environment | Credential | Needed |
| --- | --- | --- | --- |
| Domino's app-fee recipient | `DOMINO_CROSSCHAIN_FEE_RECIPIENT` | – | always |
| Relay API key | `DOMINO_RELAY_API_KEY` | `relay-api-key` | fee measurement, higher limits |
| Relay API key id (UUID) | `DOMINO_RELAY_API_KEY_ID` | – | `crosschain_fees.py relay-requests` |
| Across API key (Bearer) | `DOMINO_ACROSS_API_KEY` | `across-api-key` | production |
| Across integrator id (`0x` + 4 hex) | `DOMINO_ACROSS_INTEGRATOR_ID` | – | production |
| Provider timeout, 2–15 s (default 10) | `DOMINO_CROSSCHAIN_PROVIDER_TIMEOUT_SECONDS` | – | optional |
| Calls per minute per provider | `DOMINO_RELAY_REQUESTS_PER_MINUTE`, `DOMINO_ACROSS_REQUESTS_PER_MINUTE` | – | optional |
| Of those, the status reads' own (0 to the total − 1) | `DOMINO_RELAY_STATUS_PER_MINUTE`, `DOMINO_ACROSS_STATUS_PER_MINUTE` | – | optional |
| Destination RPC for the Across fee proof (wins over the chain RPC file) | `DOMINO_CROSSCHAIN_RPC_URL_8453`, `_42161`, `_4663` | `crosschain-rpc-<chainId>` | optional |
| V2 chain RPC file (F6): Base's and Arbitrum's hosted endpoints for the fee proof | `DOMINO_V2_CHAIN_RPC_FILE` | `v2-rpc-<chain>-<name>`, its URLs | optional |

The per-minute defaults are 45 with a Relay key and 20 without; 60 with an Across key and 10 without.
A third of each total, rounded down, is the status reads' own unless set, and quotes and listings keep the rest: with the keys, Relay's 45 are 30 for quotes and 15 for status, Across' 60 are 40 and 20. A status share of 0 puts every call back on one budget.

- **Destination RPCs.** Base and Arbitrum read the V2 chain RPC file's hosted endpoints (F6, `backend/v2_rpc.py`: Chainstack, Alchemy, then the chain's public endpoint), billed per call, one receipt per filled deposit.
  - **Order and limits:** the endpoints go in order, each with its batch, log-range and pace limits. One that fails cools down and the next answers (`EndpointsChainRpc`).
  - **No chain-id check:** each endpoint proved its chain when it was provisioned (`v2_rpc check`), so the proof never asks `eth_chainId` there.
  - **Precedence:** a destination's `DOMINO_CROSSCHAIN_RPC_URL_<chainId>` wins over the file.
  - **Robinhood** reads the listener's own node (`--rpc-config`), which the V2 file can never name.
  - **The operator's fee view** (`crosschain_fees.py across-fees`) reads the same way.
- **The listener** reuses the onboarding boundary: `backend/crosschain_api.py --enable --rpc-config <Robinhood RPC file>`, on loopback port 8910, with
  - `DOMINO_SESSION_ORIGIN` and `DOMINO_SESSION_ABUSE_SECRET`,
  - `DOMINO_CROSSCHAIN_ACCESS_ISSUER`, `DOMINO_CROSSCHAIN_ACCESS_AUDIENCE` and `DOMINO_CROSSCHAIN_ACCESS_SERVICE_ID` (the Cloudflare Access service identity),
  - the session database.

### What the owner must provide

1. **The fee recipient address.** It receives Across fees on Robinhood, Base and Arbitrum, and owns Relay's app balance. The owner chose `0x1488C84dAFc03F7f4c4fB986F83bA99Fd530c6f4` on 5 Oct 2026: the V2 registry's fee recipient, with no code on any of the three chains. Its key has never signed there (nonce 0), and Relay's balance is claimed only with its signature.
   - An EOA is the safe choice: it can sign Relay's EIP-191 claim, and it accepts ETH and every token on all three chains.
   - A contract that rejects ETH would make every native Across fill revert, so those deposits would only be refunded hours later.
   - Relay accepts an EIP-1271 contract for claims.
   - Do not use the V2 registry's recipient unless it meets this.
2. **Across API key and integrator id**, requested at docs.across.to → Tools → Get API Key & Integrator ID. Production traffic without them gets strict, unpublished limits and may be rejected.
3. **Relay API key and its key id**, from dashboard.relay.link. Quotes and status work without a key. Fee measurement (`/requests/v3`) and the default 50 quotes per minute need one.
4. **Hosted RPC endpoints for Base and Arbitrum.** Optional: without them the Across fee is reported from the provider's record instead of the destination receipt.
5. **Egress and the Worker.** The VM's egress policy admits `api.relay.link` and `app.across.to` through the role `crosschain` ([In production](#in-production)). The Worker route (`/api/crosschain/v1/` → this listener) is the bridge's `domino-crosschain-bridge`.

## In production

`scripts/staging/install_crosschain.py` installs the listener and moves it to newer releases. It starts nothing.

The bridge owns the rest of the path (0xdecimal, 5 Oct 2026):
- the tunnel hostname `vm-crosschain.domino.money`;
- its route `^/internal/crosschain/v1/(origins|quote|status)$` to `127.0.0.1:8910`;
- its Access application;
- the Worker `domino-crosschain-bridge`, which stays off until this listener answers.

1. **Install.** Run `install_crosschain.py --archive <tar> --archive-sha256 <hex> --commit <sha>`, first with `--inspect`, then with `--apply`.
   - **The first install** creates:
     - the identity `domino-crosschain`;
     - its peer row `domino domino-crosschain domino_session_auth`, proven by a connection as that user;
     - `/etc/domino/financial/crosschain`;
     - `/var/lib/domino-financial/crosschain`, with `catalogue-db.json` and the process lock.
   - **Every release** writes `/opt/domino/financial/releases/<sha>/crosschain` (the backend with `crosschain_pins.json`, and `api-contracts/v2`'s chain profiles) and the unit naming it. Every file and directory mode is set explicitly, whatever the shell's umask.
   - **Rollback:** `--rollback <sha>` puts back the previous unit, or removes it.
2. **Private files.** They go in `/etc/domino/financial/crosschain`, owned by `domino-crosschain`, mode 0600.
   - **`rpc.json`:** the plan listener's version 4 provider file, led by `https://rpc.domino.money/<token>/`. `EoaChecker` refuses the loopback proxy. Its first endpoint also serves Robinhood's Across fee proof.
   - **`chain-rpc.json`:** a copy of `/etc/domino/v2/chain-rpc.json`, F6's file for Base and Arbitrum. Its URLs are the sealed `v2-rpc-*` credentials, which the unit imports.
   - **`environment`:**
     - `DOMINO_CROSSCHAIN_FEE_RECIPIENT`, the owner's address above;
     - `DOMINO_CROSSCHAIN_ACCESS_ISSUER`, `_AUDIENCE` and `_SERVICE_ID`, the Access application's;
     - the session listener's `DOMINO_SESSION_ORIGIN` and `DOMINO_SESSION_ABUSE_SECRET`;
     - with Across' key, `DOMINO_ACROSS_INTEGRATOR_ID`, which is not a secret;
     - `DOMINO_V2_CHAIN_RPC_FILE=/run/domino-financial-crosschain-config/chain-rpc.json`.
3. **The providers' keys,** when the owner has them. Seal each once with `systemd-creds encrypt --with-key=host+tpm2 --name=<name>`, as `/etc/credstore.encrypted/relay-api-key` and `/etc/credstore.encrypted/across-api-key`, then restart the listener.
   - The unit imports them (`ImportCredential=`) with the TPM in its device policy (`DeviceAllow=char-tpm rw`; systemd 255 adds it only for `LoadCredentialEncrypted=`).
   - It unsets `DOMINO_RELAY_API_KEY`, `DOMINO_ACROSS_API_KEY` and the destination RPC variables, so no key is ever read in clear.
   - Relay quotes and tracks without a key. Across' keyless limits are strict and unpublished.
4. **Egress.** Collect with `crosschain` enabled, render, review, update, then `nft -f`.
   - The role gets the `rpc`, `jwks` and `bridges` classes. `bridges` is `api.relay.link` and `app.across.to`, both required. It also gets the replies of its listener on 8910.
   - Collected with `--v2-chains`, it also gets `chains`, Base's and Arbitrum's hosted RPC hosts, for the fee proof.
   - The tunnel gets the origin rule to 8910.
   - The 60 drop-in adds `--enable --rpc-config /run/domino-financial-crosschain-config/rpc.json`.
   - `domino-continuous-reads.target` wants the unit as a family.
   - Relay's API is behind CloudFront: its pins are the VM resolver's answer, and they move. If Relay calls stop connecting, collect again.
5. **Start.** Run `daemon-reload`, then start the unit. A request without an Access assertion gets 403. Then the bridge switches its Worker on.

**Live since 5 Oct 2026, 12:16:55 UTC**, from main `b03bc53f`:
- The owner sealed `relay-api-key` and `across-api-key` at 12:05 UTC, and both are imported. The Across integrator id `0x0380` is in the environment. The fee recipient is the owner's `0x1488…c6f4`.
- On the VM, without an Access assertion, `origins`, `quote` and `status` answer 403. So does `vm-crosschain.domino.money` from outside, without a token.
- As `domino-crosschain`, through its hosts file and its nft chain, `api.relay.link` and `app.across.to` both answer 200.

**F6's fee proof since 5 Oct 2026, 16:42:58 UTC**, release `90540b1f` (#357):
- The listener reads F6's file: `chain-rpc.json` in its private directory, owned by `domino-crosschain`, mode 0600, named by `DOMINO_V2_CHAIN_RPC_FILE`. The unit imports the sealed `v2-rpc-*` credentials with the TPM.
- Its egress (`crosschain`, collected with `--v2-chains`) admits every Base and Arbitrum host F6's file names: Chainstack, Alchemy and the public endpoint. Each resolved address was checked in the role's set.
- The fee on Base and Arbitrum is read from the destination's receipt, like Robinhood's, once a deposit fills. By 17:50 UTC only `origins` had been called (four answered 200, one 403 `origin_not_allowed`), so there is no fee proof on those chains yet.

### Quoting by output: the switch to crosschain-v1 1.1.0-rc.1

The owner chose a window (option A, 6 Oct 2026): the listener answers both versions for a while, and the Worker and the app each move to the new one.

1. **The listener first.** Release the merged commit with `install_crosschain.py --archive <git archive tar> --archive-sha256 <hex> --commit <sha>`, first with `--inspect`, then with `--apply`. Then run `systemctl daemon-reload` and `systemctl restart domino-crosschain.service`.
   - It answers 1.1.0-rc.1, and still 1.0.0-rc.1 exactly as before (the frozen models, the same bytes for the same provider answers). The live Worker and app keep working unchanged.
   - Check: `journalctl -u domino-crosschain.service -o cat | grep '"contractVersion":"1.0.0-rc.1"'` shows the site's requests, still answered 200.
   - Rollback: `--rollback <sha>`, then daemon-reload and restart.
2. **The Worker and the app, back to back** (the bridge's `domino-crosschain-bridge`, then the Pages build, from the same commit). Both speak 1.1.0-rc.1 only.
   - Between the two deploys, an open page reads the Worker's capabilities in a version it does not know, so S2 shows locked and sends nothing.
   - A tab opened before the switch stays locked until it is reloaded.
3. **Drop 1.0.0-rc.1** once the listener's lines show no rc.1 request for a few days. The steps are in the contract's [README](../../api-contracts/crosschain-v1/README.md#versions-and-the-switch-window).

**Step 1 live since 6 Oct 2026, 19:44:28 UTC**, release `db068b03` (#389, merged on main after the app's #390):
- `install_crosschain.py --inspect`, then `--apply`, from the merge commit's archive. The unit changed only its release paths (from `1a212b92`), and the listener restarted with no restarts since.
- The window, on the VM, without an Access assertion and with an empty body:
  - `1.0.0-rc.1` and `1.1.0-rc.1` each passed the version check, answered 400 `invalid_request`, and echoed their own version in the header and the request line;
  - `9.9.9` answered 502 `upstream_contract_mismatch`, in the listener's own `1.1.0-rc.1`.
- The Worker and the site still speak `1.0.0-rc.1`; step 2 is the bridge's.
- Rollback: `install_crosschain.py --rollback db068b03…`, then daemon-reload and restart.

## Operations

- **Claiming the Relay app balance.**
  1. `backend/.venv/bin/python backend/crosschain_fees.py relay-balance` shows the balance per currency and chain (Relay's example is USDC on Base).
  2. To claim, `POST https://api.relay.link/app-fees/<recipient>/claim` with `{chainId, currency, recipient}` returns a message.
  3. The fee recipient signs it (EIP-191) and the signature is posted to `/execute/permits`.
  4. Relay pays out on that chain, deducting the claim's gas in USDC. No Relay approval is needed.
  5. To hold the funds elsewhere, bridge after claiming.

  The tool never signs; the owner does steps 2 and 3.
- **Collected fees over a period:**
  - `crosschain_fees.py relay-requests --since <unix>` lists Domino's Relay requests with quoted and actual app fees, and totals what was actually collected per currency.
  - `crosschain_fees.py across-fees --chain 8453 --from-block N [--to-block M]` totals the ERC-20 fees Across fills paid the recipient. It reads `Transfer` logs from the pinned handlers to the recipient, at most 10,000 blocks per `eth_getLogs`.
  - Native ETH fees from Across leave no log. They are proven per deposit by `status`, or seen in the recipient's ETH balance.
- **Rate limits.**
  - Each provider has a per-process budget, its calls per minute.
  - The status reads have their own share of it since 3 Nov 2026: Relay's status and fee record, and Across' deposit record. Quotes and listings keep the rest.
    - The app asks about a tracked transfer every 10 s or more, so one transfer takes about 6 status reads a minute. A third of Relay's 45 follows about 2 transfers at once, and a third of Across' 60 about 3.
    - That polling never takes a quote's slot. When the status share runs out, `status` answers `provider_rate_limited` and the app asks again later.
  - A 429 blocks only its own kind of call (quotes and listings, or status reads) until its `Retry-After` passes (default 60 s, at most 10 min). During the block that kind is reported `rate_limited` without being called, so a throttled status read never blocks a quote.
  - Listings (`/chains`, `/available-routes`) are cached for 10 minutes and served stale for up to an hour if the provider fails.
  - Status reads and listings retry once after a network or 5xx failure, on the request's own slot: a failing provider costs a status poll one slot, not two. Quotes are never retried.
- **Records.** Each request leaves one `hop_log` line (route, status, duration, and the `contractVersion` the request named, so 1.0.0-rc.1 traffic can be counted during the switch window). It never includes a body, address, key or provider text.
  - Each quote answered also leaves one decision line just before it (`crosschain_service.decision_record`, the owner's request of 5 Oct 2026, after the first quotes could not be traced to a provider). Its vocabulary is closed (`DECISION_KEYS`):
    - `record: decision`, with the origin and destination chain ids;
    - `amountKind`: `exact_input` or `output` (a 1.0.0-rc.1 quote is `exact_input`);
    - `decision`: `relay`, `across` or `none`, and `reason`: `best_output`, `only_quote` or `no_quote`;
    - for each provider, its status and, when there is one, its reason, as the answer's candidates give them (for example `relay: no_route`, `relayReason: provider_no_route`);
    - `fingerprint`: the first 8 characters of the answer's `requestFingerprint`, to match the answer the Worker received.
  - Like the request line, it holds no address, amount, key or provider text, only fixed codes:
    `journalctl -u domino-crosschain.service -o cat | grep '"record":"decision"'`.

## Limits and follow-ups

- **Not admitted:**
  - origin swaps, where Relay's router or Across' `anyToBridgeable` periphery calls arbitrary DEXes;
  - non-EVM origins;
  - Relay deposit addresses;
  - EIP-3009 permits.

  Each needs its own checks before it is offered.
- **The bypass is by design.** The research of 1 Oct 2026 confirmed that nothing binds the fee: a user can bridge on relay.link or across.to (0% Relay platform fee on same-token bridges, 0.01% on USDC→USDG), or request the same keyless quote without `appFees`. Domino can only measure afterwards what it collected.
- **For F6:**
  - read destination chains and tokens from the chain registry instead of `api-contracts/v2/chains` (the RPCs already come from F6's file);
  - Relay and Across pins may move there too.
- **For F7:** the screens, through the Worker route. The contract's README lists what the app reads.
  - The app moved to 1.1.0-rc.1 by exact input only.
  - Sizing a deposit by output (one quote of what the position lacks, with the sendable balance as `maxInputRaw`) is its follow-up, with the `input_above_max` wording and the advantage sentence by rate.
- **For F8:** done by `install_crosschain.py` and the egress role `crosschain` ([In production](#in-production)), except the hosted RPCs.
- **The switch window:** drop 1.0.0-rc.1 after the switch ([In production](#quoting-by-output-the-switch-to-crosschain-v1-110-rc1)).
- **Users bring a little more than they need by output.** Relay's surplus is about the slippage and Across' about 0.47%; both arrive in the user's wallet. Relay's surplus is expected, not guaranteed: its signed minimum is exactly the need.

Sources:
- the Relay and Across documentation, and live keyless answers of 1–2 Oct 2026;
- live keyless answers by output of 6 Oct 2026: 19 quotes, from 16:00:08 to 16:09:20 UTC, with the backend's own request shapes and only the trade type and amount changed (eight of them are the `*-expected-output-*`, `*-min-output-*` and `across-quote-exact-output` fixtures);
- the answers of both days are recorded with synthetic wallets in `backend/tests/fixtures/crosschain/`;
- the adversarial verification of both fee mechanisms done for #283.
