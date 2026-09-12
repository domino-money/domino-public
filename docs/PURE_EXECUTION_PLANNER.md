# Pure execution planner candidate

12 September 2026 · E3 / [#87](https://github.com/domino-money/domino/issues/87)

`backend/execution_planner.py` evaluates fee-only self-compound, fee redirection,
Domino creation and waiting. It returns the best economically eligible candidate
**among an explicit finite set**. It does not return an executable transaction,
public API response, signable E1 plan or permission to operate a wallet.
`Decision.executionAvailable` is always `false`.

The implementation uses the reviewed E1 observation, destination, allocation,
collection and swap-bound records, hardened by #99. Their fields, encoding and
`e1-candidate-1` domain remain unchanged. The new planner records are private,
strict, frozen Python models, not an `api-contracts/` version. Exact quantities
in these internal arithmetic records are bounded integers; existing E1 raw
quantities remain canonical decimal strings.

## Inputs and authority

The caller supplies all of the following. Missing, expired or explicitly
unqualified required evidence leads to waiting, not a fabricated price, zero
fee estimate or fallback permission.

| Input | Meaning |
| --- | --- |
| E1 `Observation` | One canonical, covered block, full pool and sequence identity, current custody/policy/nonces, retained fee lots, reservations and separate accrual estimates. |
| `MeasurementHistory` | Canonical cumulative **pool LP earned token units**, sample epochs and integrated active liquidity-time. It is not change in portfolio value. |
| `PlannerSettings` | Explicit sampling/forecast bounds, forecast haircut, minimum owner benefit, operator cost buffer, service-value realization assumption and finite range/quantity alternatives. |
| `Evidence` | Current observation digest, expiry, fixed-quote price bands, operation-admission reference and destination/swap evidence. |
| `DestinationEvidence` | Current total/owner liquidity; qualified bounds on competing and total existing liquidity over the forecast; bounded active exposure and added liquidity; loss/cost allowances; complete direct-path gas cost. |
| `SwapQuote` | Admitted exact-input route/version commitment, currencies, input and minimum output, expiry/impact/slippage bounds, and **complete compound/Domino-plus-swap path gas cost**. |
| Clock and pending state | Current time, one unresolved sequence intent and unresolved parent IDs. These are supplied state, not a nonce allocator or durable reservation. |

A `qualified` value and evidence digest are adapter assertions. This module
checks their consistency; it does not prove their source, canonicality, price
integrity or on-chain enforceability. Production adapters must establish those
claims independently and bind them to the full observation. Pool APR, token
symbols and a current spot price cannot substitute for that qualification.
The fixture adapter deliberately fabricates synthetic evidence for tests only.

Prices are exact quote-asset atoms per raw currency unit, independent of token
symbols or decimal display. The immutable sequence quote currency is valued at
one of its own atoms. The pool ratio must fit the supplied price bands. This
check detects inconsistent inputs; it does not turn pool spot into an independent
oracle. Price bands and policy changes change the decision fingerprint.

## Source routing and Domino geometry

Each original source position is routed once:

- An ordinary eligible in-range source feeds itself.
- An inactive historical source, or a source below its range, sends retained
  fees to an eligible in-range member, otherwise waits. Inactive sources cannot
  contribute new accrual collections or become new parents.
- At the configured distance below the source's human-price ceiling, the source
  can feed an eligible successor or propose a child. The trigger is a percentage
  **of the ceiling**, independently of the maximum overlap.
- An existing immediate higher-ceiling child takes precedence over another
  eligible higher destination. Otherwise, eligible existing destinations rank
  by generation and numeric token ID. A pending child, ineligible existing child
  or position cap prevents an additional child.

Incoming fees preserve their original source; they do not follow the recipient's
own independently computed route a second time. Actual consumed lots/collections,
not every routed or reserved source, determine the candidate's source list and
self/redirect action. Principal, donations and external wallet balances are not
inputs to the funding calculation.

For each explicitly supplied overlap choice within policy, the candidate floor
is at least `old ceiling × (1 − overlap)` and the ceiling is at most
`old ceiling × (1 + upside)`. Exact v4 tick arithmetic rounds both bounds inward;
an empty range or one with no higher ceiling is rejected. The old ceiling may
be the new floor. This creates a **position in the same pool**, not a new pool.

Quote orientation remains fixed across the sequence. The raw v4 interval
`[lower tick, upper tick)` becomes `(human floor, human ceiling]` when inverted.
The excluded human floor in that orientation is a lower exit, so it cannot
trigger an upward ladder. Both exact endpoints and orientations have regression
coverage.

## Finite alternatives and consumption

For every qualified routed destination, the planner considers the direct path
and each bounded admitted swap quote. It finds the maximum affordable integer
liquidity within the depth cap, then compares the required explicit partial
liquidity fractions of that maximum. Fractions must include at least one partial
amount and full size; they are bounded, unique and sorted. Different input-sized
swap quotes represent smaller/full swaps; partial liquidity under a quote does
not change that quote's exact input.

A large reinvestment can lose money through costs and share dilution while a
smaller one is profitable. The comparison therefore includes quantity choices
on direct paths too. It does not claim a continuous global optimum, synthesize
unquoted swaps or select a universally optimal future execution frequency.

Already charged converted fee balances are spent first without another service
cut. Original fees are grouped by original source/currency. The cut is
`floor(gross consumed × serviceFeeBps / 10000)`, applied once. Accrual collection
budgets remain distinct from already realized reserve allocations. Integer v4
liquidity requirements round up; consumption never exceeds fee-funded budgets.
At a rounding plateau, the minimal gross amount that provides the same net
liquidity is used, preserving an atom that would otherwise only increase a fee.

Unused original fees remain uncharged. Reservations are never spent. Waiting
balances retain source, reference, amount and reason; swap output remaining after
the proposed addition is shown separately as converted residual. Its actual
receipt attribution and persistent charged-lot lineage belong to E4/E7, not to
a fabricated realization here. An accrual estimate is still only an estimate;
E4 must enforce real collection budgets without an external top-up.

## Owner economics and operator cost

The fee-flow estimate takes the minimum of the covered sample-interval LP earned
flows, valued at conservative quote-price bounds. It uses a finite explicitly
selected measurement window and forecast horizon plus a haircut. Historical
flow, even after a haircut, is an assumption rather than a guarantee of future
volume. Price appreciation without new earned token units produces no fee flow.

Let `F` be projected **total pool LP fees** over the admitted horizon, `T` existing
active liquidity, `O` this owner's incumbent liquidity and `n` added liquidity.
For fixed flow and exposure, the owner's incremental share is:

```text
(O + n) / (T + n) − O / T = n × (T − O) / (T × (T + n))
```

The supplied horizon bounds `Cmin ≤ T − O` and `Tmax ≥ T` yield:

```text
incremental earnings bound
  = F × n × Cmin / (Tmax × (Tmax + n))
      × active-fraction lower bound × forecast haircut factor
```

The bounds must cover the admitted destination's eligible exposure throughout
that horizon, not just today's pool snapshot. Total/owner current values constrain
internal consistency of those assertions. This calculation includes dilution of
the owner's existing share. A sole LP gains no additional share of unchanged
pool fee flow by adding liquidity. Earnings can never exceed the pool fee budget.

The owner gate compares those incremental earnings with the service cut, swap
loss using the output floor, and supplied exposure-loss/owner-paid-cost allowances.
The full chosen path's operator gas is paid from service revenue; it is not
deducted again from owner net benefit. Minimum swap output already reflects DEX
fees, execution impact and allowed slippage, so these are not charged twice.

Separately, conservative realizable service revenue must cover complete path
gas with the explicit buffer, and the wei gas cap must pass. A swap's gas fields
replace the direct path cost because they cover the **whole** path; an adapter
supplying only the swap leg would be invalid evidence. No treasury subsidy or
minimum service toll is invented. A charged-residual-only action can therefore
wait if it provides no service revenue to cover that action's gas.

Eligible candidates rank by conservative owner net benefit, then productive
value, then direct execution for an exact tie. Protocol revenue is not a ranking
tiebreaker. Waiting has zero incremental outcome. There is no fixed idle reserve,
15% reinvestment cap or external stablecoin funding. Fees left after a partial
choice are available for a later fresh evaluation.

## Measurement lifetime and re-evaluation

`observe` preserves valid samples and `waitingSince` across an isolated failure.
The failed attempt blocks new candidates; a later identical valid observation
recovers without counting it twice or restarting the measurement interval. An
explicit measurement-epoch change starts a new series but retains elapsed wait.
Invalid/reordered history is rejected without mutating the supplied record.

`plan` recomputes from all current inputs. Its private fingerprint includes the
observation, policy, evidence, history, settings, clock and pending state. Thus
price, depth, fee flow, gas and policy changes cannot reuse an old choice solely
because its timer elapsed. An external scheduler must invoke this pure function;
there is no background job, retry loop or timer service here.

Sampling duration, maximum sample age, minimum count, forecast horizon, quantity
choices, overlap choices and economic buffers have no implicit live defaults.
The implementation caps measurement and forecast horizons at seven days as an
arithmetic/workload boundary, not a deployment recommendation. Fixture settings
remain synthetic and unselected for release.

## Verification and remaining integration

See [implementation evidence](../reports/EXECUTION_PLANNER_IMPLEMENTATION.md) and
[synthetic vectors](../backend/tests/fixtures/execution/planner-vectors.json).
Meaningful tests cover independent liquidity boundaries, fee conservation,
per-source rounding, owner dilution, zero competing liquidity, partial quantity,
smaller/full swaps, separate gates, orientation endpoints and retained history.
Test-only translation also checks eligible candidate allocations against the
unchanged E1 validator; the production module creates no E1 execution plan.

E2/E4 custody and fee enforcement, E5 independent typed-plan reconstruction and
durable recovery, E6 actual child minting, E7 admitted swaps/receipt lineage and
qualified market/fee-growth/gas adapters remain integration requirements. Real
path costs and forecast assumptions need dated qualification. No browser payload,
provider connection, SQL migration, deployment or financial activation is added.

This supplies pure strategy/economic cases toward EX-03/04/05; it does not close
C01–C11, D01–D17, EX-01–EX-10 or the separate independent financial/audit review.
