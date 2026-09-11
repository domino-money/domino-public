# Direct-deposit RPC qualification

Observed 2026-09-10, against code `f2a0700`. This is bounded read-only evidence,
not production admission, deployment approval, token qualification or a finality SLA.

## Decision

**The public endpoint supports the required current-state RPC shapes, but it did
not serve the sampled finalized historical state. The configured Alchemy endpoint
served that exact state successfully.** Use an explicitly qualified archive
provider for receipt-time NFT/state verification; a readable block header alone
does not establish state availability.

**Robinhood runs Arbitrum Nitro, and its live gas estimates bundle execution and
data-posting costs.** An ordinary Ethereum EVM fork can qualify contract behavior
and calldata but cannot qualify Robinhood's total gas charges. The existing
`executionFeeRaw = gasUsed × effectiveGasPrice` projection must not be described
as an independently isolated execution component on this network. An absent
`l1Fee` does not authorize an additive fee formula. Nitro's `gasUsedForL1` supports
a derived poster-fee component, while a possible separate ArbOS refund prevents
assuming an exact net wallet charge from these fields alone. See the pinned-source
analysis below. [Official node documentation](https://docs.robinhood.com/chain/run-a-full-node/),
[Robinhood gas and fees](https://docs.robinhood.com/chain/gas-and-fees/),
[Arbitrum gas estimation](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas).

## Scope and evidence

- [Public RPC observations](deposit-rpc-public-2026-09-10.json): host
  `rpc.mainnet.chain.robinhood.com`, 20:02:46–20:05:48 UTC.
- [Configured provider observations](deposit-rpc-configured-2026-09-10.json): host
  `robinhood-mainnet.g.alchemy.com`, 20:06:42–20:06:48 UTC. The authorized product
  provider file was read through `local_config.load_config`; credentials and the
  credential-bearing URL were neither printed nor written into evidence.
- 42 transport attempts total: 31 public and 11 configured. Public responses:
  24 results, six explicit RPC errors, one timeout with delivery unconfirmed.
  Three later planned controls were stopped before transport. Configured:
  11 results, no RPC errors/timeouts. No retries or parallel requests.
- Requested per-call timeout: six seconds; public phase budgets: 120, 60 and
  30 seconds; configured phase budget: 60 seconds. Response ceiling: 2,000,000
  bytes. The initial 21-call public phase took 3.97 seconds.
- Only `eth_chainId`, block/transaction/receipt/state reads, canonical getters
  and `eth_estimateGas` were used. `eth_getStorageAt` was a qualification probe;
  the production `DepositRpc` allowlist was not changed. No signer, send method,
  wallet transaction, funding, personal-bot state or production-code edit occurred.

The public call used the existing `discovery.json_http` transport and its
`DominoReadOnlyDiscovery/0.1` user agent. Results do not reproduce the separate
default-user-agent HTTP 403 observed by the coordinating task.

## Blocks, freshness and finality

| Tag at initial observation | Block | Timestamp UTC | Lag from sampled latest |
| --- | ---: | --- | ---: |
| `latest` | 59,673,828 | 20:02:46 | 0 s |
| `safe` | 59,668,340 | 19:53:33 | 553 s |
| `finalized` | 59,664,499 | 19:47:06 | 940 s |

The latest header was approximately 0.80 seconds old when requested. It included
`baseFeePerGas = 132440000` wei and `gasLimit = 1125899906842624` (`2^50`). The
application's separately selected gas cap remains necessary; this header field
must not replace it.

Fixed hashes:

- Latest/source: `0xed3b1909f947db284698a66f7177dcb6c1337b03508daeed73273b87f764053c`.
- Safe: `0x814ec718f38fadd010f026f643f9f12dbcc9ac412c130640e073da41e9ecb9fb`.
- Finalized: `0xf39e931d915a2fa06483d42fd050e9906a001cd53379bdca4e4e4666395f4fc8`.

The source's numeric canonical recheck matched. At the second public sample,
latest had advanced 855 blocks/86 timestamp seconds; safe and finalized had not
advanced, making finalized lag 1,026 seconds. Alchemy later returned the same
finalized hash, with the successful historical reads approximately 19 minutes
38 seconds after that block's timestamp. This is a finite observation of a
batching/finality interval, not evidence that the tag was stuck indefinitely.

Official documentation distinguishes sequencer confirmation, Ethereum posting
and Ethereum finality, with roughly 13 minutes after posting for the last stage.
The seven-day withdrawal challenge period is separate. One-hour Permit2 approval
expiry accommodates this sample; it does not guarantee that every sequence of
separate approvals will finalize before expiry.
[Robinhood transaction finality](https://docs.robinhood.com/chain/transaction-finality/).

## Method compatibility and historical state

| Probe | Public result | Configured comparison |
| --- | --- | --- |
| Chain identity | `0x1237` / 4663 | Same |
| Latest/safe/finalized headers | Present | Latest/finalized and fixed finalized header present |
| EIP-1898 `eth_getCode` | PositionManager code, 23,877 bytes | Same length at old finalized block |
| EIP-1898 `eth_getBalance` | PositionManager balance `0x0` | Not repeated |
| EIP-1898 `eth_getTransactionCount` | PositionManager nonce `0x1` | Not repeated |
| EIP-1898 `eth_call` | Correct `poolManager()` | Correct at same old finalized block |
| EIP-1898 `eth_estimateGas` | Getter estimate `0x5747` / 22,343 | Not repeated |
| Numeric-block `eth_estimateGas` | Same 22,343 | Not repeated |
| PositionManager `permit2()` | Canonical Permit2 | Not repeated |
| StateView `poolManager()` | Canonical PoolManager | Not repeated |
| Recent fixed block code/storage/call | All returned | Same fixed getter returned later |
| Old finalized code/storage/call | Explicit metadata errors | All returned |

The successful hash selectors were `{blockHash, requireCanonical: true}`.
Unknown all-zero block hashes returned `-32000: header not found` for code, call
and estimate probes. This checks rejection of an unknown hash; it does not prove
behavior for a real noncanonical block, which was not available for testing.

The recent fixed block was 59,672,804, hash
`0x9464a5bb8b439fa8a2cc7935c2f4e644f1d7a47ec3cb00f879a4398da80f7262`, timestamp
20:01:02 UTC. At about 107 seconds old it returned code, a nonzero storage slot
and the correct getter. The same three EIP-1898 reads at block 59,664,499 returned
`-32000: metadata is not found, 59664502` on the public endpoint. Alchemy returned
the correct hash/header, code, storage and getter for that exact block, and its
numeric-block getter also succeeded. This supports provider-specific historical
state availability; it does not establish an exact public retention cutoff.
Robinhood explicitly calls for archive endpoints for historical reads and says
the public endpoint is rate-limited and not intended for production.
[Official connection guidance](https://docs.robinhood.com/chain/connecting/).

A public numeric-selector control timed out after approximately 30.01 seconds
despite its requested six-second timeout, reaching the enclosing 30-second
budget. No RPC error/result was received, so numeric historical-call support is
**inconclusive**, not unsupported. Its transport phase was not instrumented;
the existing synchronous DNS limitation is one possible cause, not a diagnosis.
The next three controls did not reach transport. This timing observation also
does not establish a six-second hard worker-exit guarantee.

## Public transaction and fee fields

The fixed full block contained 14 transactions and types `0x0`, `0x2` and `0x6a`.
One existing public type-2 transaction was sampled:
`0xf360ad0bf7a6bd6d247580010616d158b7637849216de0872cf40634ee4be3ba`.
No sender/recipient identity, raw calldata or signature was included in evidence.

Its transaction response supplied `chainId`, `nonce`, both EIP-1559 fee caps,
`gas`, `value`, `input`, canonical inclusion fields and `accessList: []`.
`authorizationList` and `blobVersionedHashes` were absent. This is compatible
with the current narrow type-2 receipt validator; other transaction types must
not be interpreted as equivalent wallet steps.

Both providers returned the same successful receipt with `gasUsed = 0x90ab`,
`effectiveGasPrice = 0x7e4dfc0`, `gasUsedForL1 = 0x0`, and no `l1Fee` property.
Logs carried the required transaction/block/index fields and `removed: false`;
an additional `blockTimestamp` was present. The observed zero field is a zero
for this transaction only, not a network-wide zero-data-fee assumption.

At `f2a0700`, the parser ignores `gasUsedForL1` and emits unavailable L1/total fields
when `l1Fee` is absent. Keeping an unavailable breakdown is conservative, but
labelling the product `gasUsed × effectiveGasPrice` as **execution-only** is not
qualified under Nitro's bundled accounting. The analysis below motivated the
narrow backend correction recorded after the source evidence.

## Pinned Nitro receipt semantics

Robinhood's node guide recommends image `offchainlabs/nitro-node:v3.11.2-3599aca`
and identifies ArbOS 61. The short commit resolves to Nitro
`3599acae1ad2fab4059fc46453c9cd3294126641`; its `go-ethereum` submodule is
`f3a977ddf30b138da2fe673ac5cbff2bc6dd4c88`. These are source-analysis pins, **not
an attestation of either provider's running binary or pricing configuration**.
[Robinhood node guide](https://docs.robinhood.com/chain/run-a-full-node/),
[pinned Nitro tree](https://github.com/OffchainLabs/nitro/tree/3599acae1ad2fab4059fc46453c9cd3294126641),
[pinned geth tree](https://github.com/OffchainLabs/go-ethereum/tree/f3a977ddf30b138da2fe673ac5cbff2bc6dd4c88).

For the ordinary type-2 transactions within the deposit flow's scope, define:

| Symbol | Receipt meaning |
| --- | --- |
| `U` | `gasUsed`, after ordinary EVM gas refunds |
| `P` | `effectiveGasPrice`, including a collected tip when enabled |
| `D` | `gasUsedForL1`, the posting charge expressed in child-chain gas units |
| `G = U × P` | Gross gas charge, before any additional multi-dimensional refund |
| `L = D × P` | Charged poster-fee component included in `G` |

The implementation converts poster cost into integer gas units, rounds down,
and charges exactly `D × P`; it deducts those units from the same gas allowance
and copies them into the receipt. Thus `L` is an included component, **never an
amount to add to `G`**. It is the protocol's charged poster fee, not a claim that
one transaction's share of the eventual Ethereum batch invoice is identical.
[Nitro charging and receipt assignment](https://github.com/OffchainLabs/nitro/blob/3599acae1ad2fab4059fc46453c9cd3294126641/arbos/tx_processor.go#L534-L615),
[receipt assignment](https://github.com/OffchainLabs/nitro/blob/3599acae1ad2fab4059fc46453c9cd3294126641/arbos/tx_processor.go#L977-L993).

The receipt price uses the same tip-collection choice as the paid gas price.
The JSON method emits `gasUsedForL1`; it does not supply an OP-style additive
`l1Fee`. `multiGasUsed` is optional and only contains resource usage when exposed;
its absence is not proof that no additional refund occurred.
[Receipt price derivation](https://github.com/OffchainLabs/go-ethereum/blob/f3a977ddf30b138da2fe673ac5cbff2bc6dd4c88/core/types/receipt.go#L302-L313),
[JSON receipt projection](https://github.com/OffchainLabs/go-ethereum/blob/f3a977ddf30b138da2fe673ac5cbff2bc6dd4c88/internal/ethapi/api.go#L1728-L1774),
[optional resource exposure](https://github.com/OffchainLabs/go-ethereum/blob/f3a977ddf30b138da2fe673ac5cbff2bc6dd4c88/core/state_processor.go#L188-L203).

There is an important limit to the common formula `total = U × P`. With
multi-dimensional pricing, ArbOS can return an additional amount `R` to the
sender after execution. The design explicitly preserves the poster charge from
this discount. Consequently `net gas fee = G − R` and `net L2 fee = G − L − R`;
`(U − D) × P` is only the **gross** non-poster component until `R = 0` is proved.
[Pinned design decision](https://github.com/OffchainLabs/nitro/blob/3599acae1ad2fab4059fc46453c9cd3294126641/docs/decisions/0003-multi-dimensional-gas-refunds.md).

The normal transaction hook performs the extra balance transfer without
reducing `gasUsed`. Geth captures `gasUsed` before invoking that hook and returns
it unchanged into the receipt. The product therefore cannot encode this refund
implicitly. Ordinary unused-gas/EVM refunds have already been accounted for;
the unknown `R` here is a distinct later refund.
[Nitro refund transfer](https://github.com/OffchainLabs/nitro/blob/3599acae1ad2fab4059fc46453c9cd3294126641/arbos/tx_processor.go#L839-L856),
[geth hook ordering and returned gas](https://github.com/OffchainLabs/go-ethereum/blob/f3a977ddf30b138da2fe673ac5cbff2bc6dd4c88/core/state_transition.go#L788-L862).

At ArbOS 61, this refund requires the multi-gas pricing model, selected by
nonempty multi-gas constraints. Resource fees and usage determine the refund;
the scalar receipt fields alone do not establish it. The chain's active
constraints were not probed. A version number or the sampled zero poster-gas
field does not resolve this unknown.
[Model selection and resource pricing](https://github.com/OffchainLabs/nitro/blob/3599acae1ad2fab4059fc46453c9cd3294126641/arbos/l2pricing/model.go#L39-L60),
[resource refund calculation](https://github.com/OffchainLabs/nitro/blob/3599acae1ad2fab4059fc46453c9cd3294126641/arbos/l2pricing/model.go#L342-L393),
[version constants](https://github.com/OffchainLabs/go-ethereum/blob/f3a977ddf30b138da2fe673ac5cbff2bc6dd4c88/params/config_arbitrum.go#L44-L61).

The pinned unit test `TestEndTxHookMultiGasRefundNormalTx` explicitly asserts a
positive refund to the sender. The separate drain regression asserts equality
with the receipt product only for configurations without a legitimate
differential refund. Those source tests were inspected, not run locally.
[Positive refund test](https://github.com/OffchainLabs/nitro/blob/3599acae1ad2fab4059fc46453c9cd3294126641/arbos/tx_processor_multigas_test.go#L88-L158),
[drain regression](https://github.com/OffchainLabs/nitro/blob/3599acae1ad2fab4059fc46453c9cd3294126641/system_tests/multi_gas_refund_bug_test.go#L122-L166).

### Minimal corrective projection recommended

At `f2a0700`, the producer at `backend/deposit_receipt.py:486–508`, Python invariant
at `backend/deposit_models.py:224–230`, and JS invariant at
`api-contracts/deposit-v1/runtime.mjs:125–126` encode `execution = G` and
`total = G + l1Fee` when that field exists. This is an additive model and must
not be retained for chain 4663. A provider extension named `l1Fee` is not
authority to select that model.

Recommend one explicit Nitro fee projection: expose `G` under a name meaning
**gross gas charge**; expose nullable `D` and `L` with their derived included-fee
basis; leave exact net total and net execution fee unavailable until additional
refund evidence is qualified. A missing `D` remains unavailable, while an
explicit canonical zero is a known zero. Do not silently redefine the existing
`executionFeeRaw` field while leaving its name or consumers unchanged. The
candidate contract, schema validators, exporter, fixtures and frontend guidance
must move together; the coordinating task owns that decision and implementation.

Focused regression cases required by that correction:

- `U=100000`, `P=100`, `D=10000`: `G=10000000`, `L=1000000`, gross remainder
  `9000000`; no additive `11000000`. Exact net remains unknown without `R`.
- With a known example refund `R=2000000`, net total is `8000000` and net L2
  component `7000000`, demonstrating why the gross remainder is not universal
  actual execution cost. This is an arithmetic counterexample, not a live receipt.
- Explicit `D=0`, absent `D`, and an extra provider `l1Fee` must have distinct,
  documented handling; absent `multiGasUsed` must not invent `R=0`.
- Reject malformed/noncanonical `D`, `D>U`, and raw-integer overflow; preserve
  values above JavaScript's safe-integer limit as decimal strings.
- Cover success and reverted receipts, nonzero collected tips, and an Anvil
  receipt without Nitro extensions. Ethereum-fork receipts must not falsely
  certify the live Nitro fee model.
- Update the currently additive receipt fixture/assertions in
  `backend/tests/test_deposit_receipt.py:84,133–155`, contract tests, flow/store
  receipt fixtures, and `api-contracts/deposit-v1/fixtures/variants/confirmed.json`.

Current bytecode, verified source, and local Ethereum EVM execution are separate
evidence categories. Neither matching deployed bytecode nor successful Anvil
calldata execution verifies ArbOS gas charging. Only a qualified live Nitro
estimate covers its bundled estimate at that observation; it still cannot
guarantee a future fee or establish an unobserved refund.

### Implemented backend correction and focused verification

The coordinating task authorized the narrow proposed-candidate correction after
the source analysis. `ReceiptSummary` now names the product `grossGasFeeRaw`, adds
nullable `l1GasUsedRaw`, derives `l1FeeRaw` only from that operand and the effective
price, and requires `totalFeeRaw: null`. The producer rejects malformed or
out-of-range `gasUsedForL1` and ignores the unqualified `l1Fee` extension. No
additional refund is invented. This is not a production activation.

Stored legacy receipts remain readable: summary projection recomputes gross
from the existing raw usage and price, while legacy L1/additive-total values
do not become qualified poster/net fees. Source operands are revalidated,
legacy records are not mutated, and the existing NFT/token evidence is retained.

Focused command:

```sh
DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -p test_deposit_receipt.py -v
```

Result: **32 passed, zero skips**, including the fresh loopback Anvil approval
oracle. Log: `/tmp/domino-qualification-receipt-tests.log`. Coverage includes
nonzero included fees, zero versus absent, ignored extensions, malformed bounds,
integer precision, prohibited net-total claims, reverted receipts and legacy
projection. Shared contract/export/fixture changes and final full-suite
verification belong to the coordinating task's integration record.

## Remaining qualification limits

No live mint/approval was simulated or sent by this probe. Getter estimation is
method-shape evidence, not mint execution evidence. Historical contract getters
are not a complete receipt/NFT reconciliation test. The sample does not prove
long-term archive retention, finality under an outage, rate-limit capacity,
reorg behavior, token semantics or production availability. The default
execution admission and all deployment flags remain unchanged.
