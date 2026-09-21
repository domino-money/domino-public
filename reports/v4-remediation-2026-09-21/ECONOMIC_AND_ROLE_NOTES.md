# Economic evidence, roles and gas funding — 21 September 2026

These corrections apply to the trust-model and reproducibility claims in the
[audit package](../V4_AUDIT_PACKAGE_2026-09-21.md). They do not restate its current
freeze, source inventory, bytecode measurements, or aggregate test totals; those
must come from the integrated build and its actual validation records.

## Replacement for the operator economic-bound paragraph

Every execution requires a published observation and an owner-configured impact
bound; swap output also has a slippage floor. The plan's add ceiling restricts a
particular submitted plan, but it is supplied by the operator and is not an
independent defense against that same operator choosing a broad ceiling.

The historical fork samples exercised ordinary Anvil against real pool state.
Their successful pre-observation scenarios had positive vault values relative
to the corresponding honest planning recipe and negative attacker pool PnL at
the sampled sizes. This does not prove manipulation is generally unprofitable:
it depends on liquidity, range, fee reserves, position share, pool fees, gas, and
the number of executions exposed to one manipulation. The original swap
“shortfall” column was an anchor-derived quote, not a receipt measurement, and
the original swap-vault deltas used the wrong control. The
[corrected report and tables](../EXECUTION_FORK_SANDWICH_2026-09-20.md) supersede
those interpretations. Missing original swap outputs remain unavailable.

There is no demonstrated $500 per-vault or per-compound safety threshold.
Several vaults can trade while one pool remains manipulated and share the
attacker's move-and-restore cost. Economic qualification must consider aggregate
executed notional across the pool and manipulation window, including cumulative
impact. The current point samples establish neither a universal break-even
threshold nor an on-chain aggregate exposure cap.

## Replacement role and publisher-rotation wording

| Role | Authority and limit |
| --- | --- |
| Price publisher | Publishes bounded observations and revokes observations. One observation can be reused by multiple actions or vaults; neither its commitment nor `referencePrice` binds it to one execution or marks it consumed. |
| Price guard guardian | Proposes a replacement publisher and revokes observations. It can nominate itself or another address it controls. It therefore has indirect publishing authority through role replacement, but no direct vault custody or policy authority and no power to widen the immutable deviation band. |
| Service fee recipient | Receives the service cut in the consumed currency. Receiving fees confers no vault execution or withdrawal authority; the recipient remains free to transact with assets it owns. |

Publisher rotation is a **two-call acceptance procedure**:
`guardian.proposePublisher(candidate)`, then `candidate.acceptPublisher()`.
The old publisher does not approve it. The contract does not prove independent
people or keys, and it permits the guardian to become publisher. Constructor
and release-input address separation are useful deployment rules, not enduring
proof of independent control after rotation.

The honest admitted backend checks the live publisher against the profile and
requires profile re-admission after an unexpected change. This is a software
admission boundary. It is not an on-chain revocation of the operator and cannot
be relied upon to restrain an already-compromised operator that submits calls
directly. Previously published observations remain readable until revocation or
their normal timestamp/L2-block expiry; rotation alone does not invalidate them.

Source references: [guardian rotation](../../contracts/src/DominoPriceGuardV4.sol),
[observation use](../../contracts/src/DominoExecutionEngineV4.sol), and
[backend publisher admission](../../backend/execution_v4.py).

## Replacement mutation-reproducibility wording

The mutation runner and its own unit tests are present at
[`scripts/mutate-contracts.mjs`](../../scripts/mutate-contracts.mjs) and
[`scripts/mutate-contracts.test.mjs`](../../scripts/mutate-contracts.test.mjs).
The historical reports describe mutation outcomes, including 39 price-guard
mutations and 15 arithmetic mutations. The exact JSON batches and per-mutation
raw outputs underlying those historical totals were **not committed** in the
original audited revision `7be7820`. Its repository search found no JSON record
with a `mutations` array outside build/dependency output. The remediation adds
two new targeted batches; their [8/8 caught results](mutation-results.json) do
not recreate the missing historical batches. Tool availability alone does not make
those exact historical totals reproducible.

Treat those counts as historical assertions, not as freshly reproduced
coverage of the corrected sources. A new mutation claim should commit the
precise batch, target revision, passing baseline, and actual verdict output.
`NOT APPLIED` and `NO BUILD` prove no guard coverage. Source changes require
new matching mutations; a historical textual mutation that no longer applies
must not silently count as caught. Passing ordinary tests is separate evidence
and must not be relabelled mutation coverage.

## Actual gas payers and no automatic asset sale

The sender pays transaction gas in native ETH. The deployer pays deployment,
the publisher pays its observation transaction, and the operator pays an
automated execution. An owner pays for transactions they submit directly,
including setup and exits. Failed transactions can still consume the sender's
gas, although a reverted compound transfers no service fee.

The operator must have ETH beforehand. The signer checks its native balance
against the configured gas limit and fee cap and rejects insufficient funding
with `execution_gas_balance`. The fee-balancing swap sends output to the vault;
the service cut goes to the immutable recipient in the consumed currency.
Neither path tops up the operator or automatically sells principal, reserves,
or service-recipient assets for gas. Treasury conversion and operator funding
are not implemented as an automated service. The approved 2% earned-fee cut
includes operator compensation/gas economically; there is no additional
principal debit.

The simulator gives synthetic sender accounts ETH with `anvil_setBalance`.
It records `gasPayer`, `gasFunding`, and the receipt gas product, and separately
tracks the attacker's sender gas debit. These child-chain controls are not
evidence of live treasury funding or total Nitro fees. The durable product
explanation is in [V4 execution](../../contracts/V4_EXECUTION.md#who-pays-gas-and-how-the-operator-is-funded).

## Historical data and current reruns

The original narrow, wide, and lifecycle JSON records dated 20 September remain
unchanged. The separately named `*-corrected-2026-09-21.json` files preserve
their observations, move superseded numeric interpretations under
`supersededMetrics`, and recompute same-recipe controls without fabricating
unrecorded `FeesConverted` outputs. They are derived historical evidence, not
new fork executions. The [corrected report](../EXECUTION_FORK_SANDWICH_2026-09-20.md)
links all records and explains their limitations.

The corrected simulator's `--help` was checked. From the integrated repository,
after the complete corrected artifacts and `MockNitroArbSys` fixture exist, run
the following **sequentially**. Each command selects a fresh public-source head;
do not reuse an old `--block` on a pruned endpoint. No private provider file is
loaded with `--public-rpc`.

```sh
DOMINO_COMPOUND_EVM_ROOT="$PWD" backend/.venv/bin/python backend/qualify_execution_fork.py \
  --public-rpc --pool weth-usdg --width 200 --rounds 40 \
  --moves 50,90,110,500,2000 --lifecycle \
  --output reports/fork/weth-usdg-narrow-remediated-2026-09-21.json

DOMINO_COMPOUND_EVM_ROOT="$PWD" backend/.venv/bin/python backend/qualify_execution_fork.py \
  --public-rpc --pool weth-usdg --width 2000 --rounds 40 \
  --moves 50,90,110,500,2000 \
  --output reports/fork/weth-usdg-wide-remediated-2026-09-21.json
```

For a quick availability check before full runs, use the narrow command with
`--rounds 1 --moves 50`, omit `--lifecycle`, and choose a separate output name.
That shorter run does not replace full economic qualification. Output files
are created exclusively; choose a new name when preserving a prior run.

Public source availability and its pruning window can prevent a full rerun.
Record the actual result, including failed setup or unavailable historical
state. The explicit ArbSys stand-in is local emulation, not proof of live Nitro
opcode behavior; live block-domain probes and finalized-source qualification
remain separate evidence. This note itself launches no fork or compiler.
