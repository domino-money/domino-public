# Direct deposits — Robinhood fork qualification

Issue #42 · 2026-09-10 · parent implementation `f2a070052b46d3c1b57c72647f5ebfc0d3dce25a`.

**Four deposit paths were observed to mint and reconcile successfully against
forked Robinhood deployments. Production admission remains blocked.** The final
five-case matrix passed three paths; a separate diagnostic run passed the
USDG-only path that had failed in the matrix. The ETH-only composition remains
rejected. These observations qualify bounded protocol behavior, not reliable
availability across all requests, all tokens or production readiness.

## Evidence and controls

- [Final five-case matrix](deposit-fork-qualification-2026-09-10.json).
- [Separate USDG-only diagnostic](deposit-fork-usdg-only-2026-09-10.json).
- [Deployment and token review](DEPOSIT_DEPLOYMENT_REVIEW.md), with pinned source
  revisions, runtime comparisons, proxy implementations and public evidence.
- [RPC and Nitro fee qualification](DEPOSIT_RPC_QUALIFICATION.md), with public
  and configured-provider comparisons at the same historical block.

Both committed execution reports were produced by the new opt-in harness using
Anvil 1.7.1 and the production preparation/receipt modules. The diagnostic run
wrapped preparation only to print a finite internal failure code; instrumentation
changed no generated inputs or validation. Its newer source block produced a
different USDG-only range: `[-202228, -200228]`, versus `[-202220, -200220]` in
the matrix. It was not an exact replay. The negative admission control intentionally
raises `DepositError`; that message is not a failed USDG mint.

Real upstream operations were source/state reads and Uniswap LP composition.
**Zero mainnet transactions were signed or sent.** The sole deposit owner was
the public placeholder `0x000000000000000000000000000000000000dead`, impersonated
on a newly spawned child node with no generated accounts or private keys.
PoolManager was separately impersonated only for local bootstrap funding below.
Credentials came from ignored product development configuration, never the
personal bot. Reports retain public identities and a provider hostname, not
keys, credential-bearing URLs, signatures, raw calldata or private wallet data.

`ForkReadGateway` accepts only bounded read methods/parameters. Anvil receives
its temporary loopback URL, never the upstream credential. The child chain ID
and source block hash are checked before mutations; the upstream chain is
checked independently before starting the child. Source canonicality is checked
again at completion. Reported gateway `closed: true` records completed cleanup.
Ordinary CI exercises a completely offline parent/child test demonstrating that
a child transfer changes neither upstream balance, nonce nor receipt state.

Local bootstrap credits synthetic ETH for gas, wraps 0.1 ETH using the actual
WETH implementation, and transfers 100 USDG from the locally impersonated
PoolManager through the actual token implementation. This changes local protocol
reserves and is explicitly recorded; token code/storage is not replaced. These
are controlled execution experiments, not an economic backtest of untouched
mainnet reserves. Each case starts from and restores a local snapshot.

## Results

| Case | Observation | Final matrix wallet steps |
| --- | --- | ---: |
| WETH/USDG, WETH independent input | Mint and receipt passed | 5 |
| WETH/USDG, USDG independent input | Mint and receipt passed; fresh compositions required additional bounded approvals | 7 |
| ETH/USDG, native independent input | Mint, receipt and controlled native refund passed | 3 |
| ETH/USDG, ETH-only range | Rejected contradictory provider amounts before any wallet step | 0 |
| WETH/USDG, USDG-only range | Matrix stopped before mint after two approvals; separate run passed | 2 in matrix; 3 in separate run |

The final matrix retains **both failures**. It is not replaced with a clean run.
The USDG-only failure was `deposit_preparation_unavailable` after two confirmed
local approvals. Its inspected nominal amounts and encoded caps agreed; the
original finite public error does not establish the underlying cause. A separate
bounded diagnostic at a new source block completed the approvals and mint.
That success proves an observed viable path, not resolution of the intermittent
failure. A user in the failed state would retain the completed approvals and
need fresh preparation; no failed preparation is silently broadcast or called
successful. No retry loop or production validation relaxation was added.

For ETH-only, the final Uniswap response said `1000000000000000` wei while its
validated calldata capped native debit at `999999999999371` wei: a **629 wei
contradiction**. This may involve provider rounding, but that cause has not been
proven. The adapter correctly rejects it. We neither invent a tolerance nor
substitute our own LP math or silently relabel a maximum as an expected deposit.
This path needs a coherent provider composition before it can be qualified.

Every successful mint exercised these checks against actual forked code:

- ERC20 approval to Permit2 and expiring Permit2 approval to PositionManager;
  only required sides are approved, with selected amount/gas/nonce bounds.
- Exact pool identity, range, recipient, liquidity, NFT creation/ownership and
  receipt identity, using the current deposit preparation and reconciliation.
- Actual standard-token receipt quantities equal controlled single-transaction
  balance deltas and remain within the inspected calldata caps.
- A deliberately expired alternate mint reverts on-chain and reconciles as
  reverted; restoring its snapshot makes its orphaned receipt detectable.
  The valid mint then succeeds in the restored local history.
- The preparer denies missing production admission before any LP API call;
  synthetic in-memory admission is explicitly labeled and never exported.

The three successful matrix mints used 353,121, 353,121 and 327,317 gas units
respectively. These are **Ethereum Cancun Anvil measurements, not Robinhood gas
quotes**. Local mining/finality and base-fee evolution are artificial. The local
NFT ID can repeat across cases because each case restores the same snapshot;
these are not NFTs created on mainnet.

The matrix ETH/USDG mint sent at most `1026364660655977` wei, deposited
`999377997978901` wei, and returned `26986662677076` wei in the controlled local
transaction. Public receipt `amount0Raw` intentionally remains null for native
currency: real whole-block wallet balances cannot isolate one transaction's
refund. ERC20 amounts remain exact raw strings; no USD gas estimate, APR or
profitability claim is derived from these tests.

## Corrections exposed by qualification

The prior receipt labeled `gasUsed × effectiveGasPrice` as an execution-only
component and added a separately reported L1 fee. On Nitro this is a **gross gas
charge that already includes the poster component**. The coordinated, disabled
`deposit-v1` 1.0.0 candidate migration replaces `executionFeeRaw` with
`grossGasFeeRaw`, adds nullable `l1GasUsedRaw`, derives included `l1FeeRaw`, and
keeps `totalFeeRaw` null because additional ArbOS resource refunds are not
qualified. Missing data and explicit zero remain distinct. Legacy stored
receipts are projected from validated raw operands without treating their old
additive totals as authoritative. See the [consumer contract](../api-contracts/deposit-v1/README.md).

This is a pre-release payload migration requiring OxDecimal's acknowledgment
before integration or activation. It is not a backward-compatible rename or a
deployed release. Read/session/onboarding payloads and frontend files are unchanged.

The qualification tests also exposed a response-resource cleanup issue: the
shared HTTPS transport now closes caught HTTP errors before emitting its fixed
redacted error. This prevents deferred resource warnings from retaining private
upstream details; a regression checks closure and redaction together.

## Remaining release gates

1. WETH and USDG are upgradeable proxies and fail the present immutable-token
   admission policy. No production token or pool was admitted. Choose reviewed
   immutable candidates or separately design implementation/facet-aware proxy
   support; do not mark these assets nonupgradeable to pass the guard.
2. Resolve the ETH-only provider inconsistency and characterize the intermittent
   USDG-only preparation failure before promising those paths as reliable.
3. Use a qualified archive provider for historical receipt/NFT reads. The public
   endpoint failed the sampled finalized state that Alchemy served. This sample
   is not an uptime or retention guarantee.
4. Qualify Nitro net/refund accounting and real finality operational behavior.
   Local mining cannot substitute for Robinhood settlement evidence.
5. Complete independent review, exact frontend contract acknowledgment,
   wallet/UI integration, staging and explicit activation gates. No deployment,
   merge, service enablement or personal-bot change belongs to this qualification.

## Reproduce explicitly

Install root npm tools and the locked backend environment from the README.
Configure the product RPC and Uniswap key locally using their existing hidden
input helpers. The following command reads those private files but does not
print their content or submit real transactions:

```sh
backend/.venv/bin/python backend/qualify_deposit_fork.py \
  --rpc-config /absolute/path/to/product/providers.json \
  --uniswap-config /absolute/path/to/product/uniswap-api.json \
  --output backend/runtime/deposit-qualification/result.json
```

Optional repeatable `--case` accepts `weth-input`, `usdg-input`, `native-input`,
`native-only`, `usdg-only`. Source state and external compositions will change;
this command does not promise bit-for-bit replay of a historical report. Each
run is bounded by the gateway/child's 1,200-second and 5,000-request limits, and
each case has at most 12 preparations and 16 composition calls. It returns 0
only when every selected protocol path passes; 2 preserves findings or failure.
Ordinary CI never runs this credential-dependent command.

## Verification

| Check | Result |
| --- | --- |
| Complete backend with PostgreSQL and EVM | 794 passed, zero skips |
| Bridge and shared contract consumers | 517 passed, zero skips |
| Strict TypeScript deposit consumer | Passed |
| Read/session/onboarding/deposit exports and read OpenAPI | Matched |
| Repository hygiene and whitespace | Passed before commit |

The full suite includes receipt accounting/legacy projections, gateway
denial/redaction, fork isolation and API compatibility. Real-fork evidence
remains separate from offline CI. GitHub CI status is attached to the PR's
exact commit; this report does not substitute for a green remote run.

Final `api-contracts/deposit-v1/manifest.json` SHA-256:
`d65524c5d7eaf378289a7863aaf51760b15ebf185dd9a19e972e803fe7416f3c`.
Onboarding remains
`e4dfb8adf7f53e22ac1724a4c1bf089391a8706be2163ee7e3d44c7e4b38e6aa`.
No consumer acknowledgment is inferred from this export.

```sh
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -v
npm run check:read-bridge
backend/.venv/bin/python scripts/export-read-contract.py --check
backend/.venv/bin/python scripts/export-read-openapi.py --check
backend/.venv/bin/python scripts/export-session-contract.py --check
backend/.venv/bin/python scripts/export-onboarding-contract.py --check
backend/.venv/bin/python scripts/export-deposit-contract.py --check
node web/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext api-contracts/deposit-v1/types.ts api-contracts/deposit-v1/runtime.d.mts api-contracts/deposit-v1/consumer.typecheck.mts
backend/.venv/bin/python backend/dev_postgres.py stop
python3 scripts/check-repository.py
git diff --check
```
