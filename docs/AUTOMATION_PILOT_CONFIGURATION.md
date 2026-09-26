# Automation pilot configuration

The automation cycle reads one private configuration, and each gas peer one more.
`backend/configure_automation.py` composes the three files from two committed inputs
and a few host values:

| Input | Where | What it supplies |
| --- | --- | --- |
| The release record | `docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json` | The pin (SHA-256) of the sequence profile and every address, role, tariff, expiry and runtime hash it must agree with |
| The sequence profile | `…/sequence-release.json` | The `deployment` admission, copied as is once it matches the record |
| The parameter profile | `…/automation-pilot-v1.json` | Every operational number: planner, pricing, swap cap, gas, destinations, history, plan, scheduling, finality, ledger, both signers' caps |
| The host | fixed by the [installer](AUTOMATION_INSTALL.md) | The financial database socket, the VM-local loopback RPC `http://127.0.0.1:18547/`, and the key paths inside the unit's read-only mount `/run/domino-financial-automation-config/` |
| The operator's command | `--sequence owner:vault`, `--sequence-expires-at`, `--worker-id` | Which vaults are admitted, until when, and the host's stable worker identity |

It reads no key and writes none: the configuration only names where the unit finds
`operator.key` and `publisher.key`, and their owner places them. Nothing is defaulted
from test fixtures, and every file is validated by the loader that will read it.

```sh
python backend/configure_automation.py \
  --release docs/deployments/v1-robinhood-mainnet-2026-09-21 \
  --profile docs/deployments/v1-robinhood-mainnet-2026-09-21/automation-pilot-v1.json \
  --sequence 0x<owner>:0x<vault> --sequence-expires-at <unix seconds> \
  --out /private/automation-config
```

It writes `automation/config.json`, `gas-reservation/config.json` and
`gas-settlement/config.json` (0600, in new 0700 directories; nothing is overwritten)
and prints each file's SHA-256 and the worker id. Keep the worker id: passing it again
with `--worker-id` when the file is regenerated lets a restarted service resume its own
leases. On the VM, as root, each file goes to its peer's directory with its owner:

```sh
install -o domino-automation -g domino-automation -m 0600 automation/config.json /etc/domino/financial/automation/config.json
install -o domino-gas-reservation -g domino-gas-reservation -m 0600 gas-reservation/config.json /etc/domino/financial/gas-reservation/config.json
install -o domino-gas-settlement -g domino-gas-settlement -m 0600 gas-settlement/config.json /etc/domino/financial/gas-settlement/config.json
```

The two keys (64 lowercase hex characters each) go to
`/etc/domino/financial/automation/operator.key` and `publisher.key`, 0600, owned by
`domino-automation`. The operator key's address must be the release's `operator`, the
publisher key's its `pricePublisher` and the price guard's `publisher()`. Keys never
pass through a repository, a log or an assistant.

## What the generator refuses

| Code | Why |
| --- | --- |
| `sequence_profile_digest_mismatch`, `sequence_profile_disagrees_with_release` | The admission is exactly the reviewed release's |
| `automation_profile_invalid` | A profile names every section, and never a key file or a worker id |
| `planner_version_mismatch` | `planner.version` is the SHA-256 of the planner's other numbers, so no number changes under an old version |
| `automation_profile_for_another_release` | A profile is measured for one release |
| `sequence_required`, `sequence_invalid`, `sequence_duplicate`, `sequence_expiry_invalid` | Admission is explicit, and no sequence outlives the release profile (2026-10-21 19:01:30 UTC for V1; every pass returns `admission_expired` after it) |
| `evaluation_interval_above_readiness` | The app offers activation only while the service's heartbeat is fresh; above 15 seconds it never is |
| `minimum_balance_below_envelope` | The signers refuse a balance below their envelope only after the publication is paid, so the gate before it asks for the worst envelope |
| `swap_units_below_mint` | Every swap quote is priced with the swap units, a successor's mint included |
| `sample_gap_below_waiting_cadence` | A waiting sequence is sampled only when a pass runs; a gap longer than the admitted one starts a new series, and a series that always restarts never plans |
| `measurement_window_too_short`, `sample_age_below_interval` | The window must hold the samples the planner asks for at the slowest cadence, and a pass samples before it plans |

## The pilot profile, `pilot-v1-2026-09-26`

Chosen for one controlled sequence, from the code's own use of each number, the
[gas units on the deployed contracts](../reports/GAS_UNITS_V1_2026-09-22.md), the
[gas funding study](../reports/GAS_FUNDING_STUDY_2026-09-21.md), the
[new-token study](../reports/NEW_TOKEN_AUTOMATION_STUDY_2026-09-22.md) and the limits the
app writes on a new vault (`app/src/lib/create/sequenceDefaults.ts`: 1% slippage and
impact, 20% overlap, 60-minute interval, 5-minute observations, 168-hour horizon,
0.005 ETH of gas per run). **Owner decisions** are marked; each is a margin, not a
measurement, and changing one is a new profile version.

| Section | Values | Basis |
| --- | --- | --- |
| Signers | Operator: `max_gas` 3,000,000, `max_fee_per_gas` 0.5 gwei, `max_total_cost` 0.0015 ETH. Publisher: `maxGas` 400,000, `maxFeePerGas` 0.5 gwei, `maxTotalCostWei` 0.0002 ETH | A successor mint with a swap and its L1 part is about 2.4 M; a publication with its L1 part about 216 k. 0.5 gwei is about the highest base fee the funding study saw in an hour (0.050–0.492). Above it, a cycle waits. `max_replacements` and `expirySeconds` are not used by the cycle |
| Gas | publish 175,000; direct 1,300,000; mint 2,100,000; fund 1,450,000; **swap 2,500,000**; base-fee buffer 25%; L1 from `NodeInterface`; minimum balances 0.003 ETH (operator) and 0.0004 ETH (publisher) | The measured maxima plus 10%. Swap quotes also price successor mints, and mint plus swap was never measured, so swap covers it (for an Auto-compound swap this overstates the cost by about 1 M units). The minimums are twice each worst envelope; with 0.018 ETH funded, 0.015 is usable |
| Planner | 3 samples over at least 30 minutes, inside a 60-minute window, newest at most 20 minutes old; horizon up to 7 days; **forecast haircut 20%**; operator cost buffer 15%; **service realization 98%**; overlap choices 0/5/10/20%; liquidity fractions 25/50/75/100% | The horizon must reach the vault's 168 hours, or every pass returns `forecast_horizon_not_admitted`. The 15% buffer is the approved one ([REINVESTMENT_POLICY](../REINVESTMENT_POLICY.md)). A minimum owner benefit of 0 leaves the margin to the proportional haircuts, which hold in any quote currency |
| History | one sample per 15 minutes, a new series after 30 minutes without one | The fee rate is the quietest 15-minute bucket of the window, so a bucket without a swap stops the plan: the pilot pool must trade in every quarter hour |
| Pricing | the pool's spot, a 0.25% valuation band, WETH as the native wrapper, the ETH/USDG pool for USDG quotes, a 1% gas price buffer | The owner's decision of 22 September; the band covers the 20-second drift the [price-band report](../reports/PRICE_BAND_QUALIFICATION_2026-09-21.md) measured (at most 0.11% of price across seven pools) |
| Swap cap | **50% of fee × depth** | 100% is where a push-and-restore sandwich breaks even; half leaves room for a pool whose other liquidity is largely one party's |
| Destinations | the addition at most 10% of the pool's active liquidity; **competing-liquidity haircut 10%, total-liquidity margin 10%, active-fraction haircut 10%**; **successors assumed in range 50% of the time**; **no exposure loss**; swap sizes 25–100%, none below 10% of the fees; swap quote slippage 0.5%; 64 simulation steps | Slippage stays under the vault's 1%. The successor fraction is an assumption the fork rehearsal saw no successor pass at |
| Plan | 60-second deadline, 0.0015 ETH gas cap, the NET path first, 0.5% liquidity slack | Inside the vault's 5-minute observation age and 0.005 ETH cap; the worst operator envelope equals the cap, so a gas spike waits instead of refusing at publication |
| Scheduling | a pass every 10 seconds; backoff 30–300 seconds with 20% jitter; **at most 3 publications, then 24 hours**; publication wait 15 s, execution wait 10 s; a source block at most 100 blocks old; 90-second pass budget; latency reported against 5 seconds | The heartbeat needs a pass every 15 seconds or less. The publication budget counts a chain of publications each within 24 hours of the previous one. 100 blocks is 6–14 seconds (256 took 15–37) and leaves the guard's 255-block window room for the execution |
| Finality and ledger | publications used at inclusion; the vault's fee events read inline, 20,000 blocks and 1,024 logs per pass | The execution fails closed if its publication vanished |

## What a compound has to earn

Two gates must pass before anything is published. At the median base fee the funding
study measured (0.0518 gwei) and ETH at about US$2,700, with the buffers above:

- **Operator gate:** a direct compound costs about US$0.30 with its publication, so the
  service fee must cover it. That is about **US$15 of fees consumed** in Auto-compound
  (2%) and about **US$8** in Domino-compound (4%). A position earning less waits until
  its fees accumulate.
- **Owner gate:** the added liquidity's fee share over the horizon, after the haircuts,
  must beat the fee and the gas. The added liquidity only earns against other
  liquidity: **a vault that is the only in-range liquidity never compounds**.

The pilot vault therefore belongs in a hookless pool with other LPs, trades in every
quarter hour, and fees of at least that order. Auto-compound is the safer first mode:
no Domino-compound successor passed the economic gates on the fork.

## Before and after the first cycles

Measured only on the real chain, and compared on the first cycles:

- gas units under Nitro and the L1 component the node quotes with real calldata
  (compare each evidence's `l1Units` with the receipt's `gasUsedForL1`);
- latency from the observed block to the execution (`maxSourceBlockAge`,
  `publicationWaitSeconds`);
- the base-fee distribution beyond one hour (`max_fee_per_gas`, the buffer);
- whether the chain charges a tip (`effectiveGasPrice` against the base fee);
- the pilot pool's quiet gaps (the sampling interval) and the evidence's
  `incrementalEarningsQuote` and `ownerNetBenefitQuote` in `evaluate` over a window.

Any change is a new profile version and a regenerated file. The activation order stays
the [runbook's](AUTOMATION_CYCLE_RUNBOOK.md#activation): keyless `status` and `evaluate`,
a keyless settlement pass, the gas peers, one `run-once`, then `serve`.
