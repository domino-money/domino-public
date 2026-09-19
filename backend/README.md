# Backend foundation



[Execution policy](../docs/EXECUTION_POLICY.md) supersedes historical owner, ACK
and approval procedures here. Any authorized collaborator or agent may implement
and operate within scope, recording results alongside or after execution.
Technical controls, compatibility evidence and wallet consent still apply.



The [managed-performance collection candidate](../docs/MANAGED_PERFORMANCE_COLLECTION.md)
adds forward canonical opening/receipt acquisition, a private durable journal and
an authenticated `performance-v1` card projection. Financial metrics remain null
until the execution-effect adapter and qualified valuations complete their evidence.
It adds no running listener, scheduler, frontend hook or live execution capability.





The [E1 hardening boundary](../reports/EXECUTION_E1_HARDENING.md) supplies strict
derived-record/JSON validation and offline plan/effect reconciliation for future
executor work. Its observations and measurements remain caller-supplied; no
public execution route, signer, live receipt collector or transaction is added.

The [V3 compound receipt verifier](../docs/PUBLIC_VAULT_V3_COMPOUND.md#backend-receipt-boundary)
now acquires a known transaction, its receipt and pinned canonical state. It
reconstructs original/charged fee use, actual service cuts and added liquidity;
optional E1 reconciliation still requires exact immutable allocations. This is
an internal read-only module, with no automatic polling, persistence or route.
Realization remains unqualified as earning time, USD income or a complete APR.



The [forward financial history producer](../docs/MANAGED_FINANCIAL_HISTORY.md)
connects persisted canonical pages to V3 receipt effects, exact capital/accrual
observations and qualified event-time valuation. Its separate financial journal
survives failed reads/replay and preserves owner isolation. This is an internal
review candidate; the current card contract still requires null financial values.


The local [APR metrics candidate](../docs/APR_METRICS.md) adds exact pool-estimate
and managed fee-performance calculators plus `preview_metrics.py`. Pool mode
can use the existing on-demand reader; managed mode consumes explicit offline
evidence. This does not add an HTTP route, replace `feeApr24h`, collect live
managed receipts or enable card refresh. The examples distinguish estimates,
complete-day performance, measuring, missing and stale states.

The disabled [wallet-session candidate](../docs/WALLET_SESSIONS.md) is a separate
auth listener on loopback port 8879, backed by private PostgreSQL state and a
plain-EOA SIWE verifier. It does not authenticate through the public reader,
grant financial permission or connect frontend hooks. Its shared contract is
`api-contracts/session-v1/`; the public-read documentation below stays unchanged.

Issue #40 adds a disabled [direct-deposit service](../docs/DIRECT_DEPOSITS.md)
on loopback port 8881 with private PostgreSQL operation state. It prepares one
exact owner-signed approval or mint at a time, verifies receipts and recovers
interrupted work. Its separate `deposit-v1` contract requires reviewed token
admission before preparation; it has no private key or broadcast method.
Read/session payloads and frontend hooks remain unchanged. See
[implementation evidence](../reports/DIRECT_DEPOSIT_IMPLEMENTATION.md).
Issue #49 adds [operator-managed wallet admission](../docs/WALLET_ACCESS.md)
to that candidate: login/private access is denied unless chain 4663 and the
wallet's current grant generation match. Public reads remain open. The
`session-v1` candidate is 3.0.0-rc.2; no initial wallets or services are enabled.
The selected [home VM deployment](../docs/HOME_VM_RUNBOOK.md) still requires
integrated-release validation and application configuration; the VM/empty PostgreSQL
foundation is installed and four initial wallets are held privately for later admission.

Issue #42 adds opt-in [Robinhood fork qualification](../reports/DEPOSIT_FORK_QUALIFICATION.md)
through a read-only upstream gateway and an isolated Anvil child. Four protocol
paths have observed successful mints; the report preserves unsupported and
intermittent single-asset cases. That qualification used test-only proxy assumptions. Nitro
receipt accounting uses gross gas with an included poster component and unknown
net total. This is a coordinated pre-release `deposit-v1` migration, requiring
producer/consumer compatibility validation and a notice alongside or after
delivery. The qualification CLI is separate from every public listener and
from offline CI.

Issue #44 adds [reviewed-token admission](../docs/REVIEWED_TOKEN_ADMISSION.md)
for immutable tokens and ERC-1967 transparent/UUPS proxies. WETH/USDG have dated
source-backed profiles, fresh preparation/re-delivery checks and historical
receipt identity checks. USDG payout-group accounts are outside the initial
profile. [Current implementation evidence](../reports/UPGRADEABLE_ADMISSION_IMPLEMENTATION.md)
records four observed fork paths using the actual reviewed profiles and preserves
provider/read failures. The helper only creates a private candidate file; all
services remain disabled in this candidate, with consumer validation and
technical release evidence pending. No named collaborator's ACK is required.

API 0.8.0 follows the [MVP data strategy](../MVP_DATA_STRATEGY.md): read indexed
market data on demand and keep exact historical reconstruction optional for
onboarding. No lifetime backfill starts when a user reads a pool.

## On-demand pool market data

The [#123 RPC batching candidate](../docs/READ_RPC_BATCHING.md) preserves the
same snapshot proofs and logical request budgets while reducing independent
snapshot checks to two bounded envelopes. Its unchanged-wire notice and
separate endpoint qualification requirements are documented there.

`POST /v1/read/pool-market` accepts a full v4 PoolId, optional boolean
`includePriceHistory` (default false), and `priceToken` (`base` or `quote`,
default base). The latter names the verified market observation's base/quote
addresses, which are returned with the chart; it is not implicit token0/token1.
The provider request selects that token by address. The adapter verifies OHLCV
metadata and maps only its labels back to the market orientation, preserving
every candle value. See the [chart qualification report](../reports/ALPHA_CHART_CURRENCY_QUALIFICATION_2026-09-12.md).

```json
{"poolId":"0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6","includePriceHistory":true,"priceToken":"base"}
```

The route rereads canonical Uniswap deployment links, the full PoolKey and
current state, then attaches attributed GeckoTerminal `reportedLiquidityUsd`
and `volume24hUsd`. Optional OHLCV contains up to 24 hourly candles with the
actual currency address, timestamps, open/closed flags and gap coverage. This
does not prove a complete trailing 24-hour window. Neither active liquidity
nor the PoolManager balance is converted into pool TVL.

Market and chart observations have separate status and cache metadata. Missing
values stay null; zero is retained only when reported. A provider failure keeps
the current verified pool readable. A mismatched chain, full PoolId, currencies,
DEX identity or chart orientation rejects the affected observation. PoolId does
not include PoolManager, so another DEX's similarly hashed pool is not accepted.

The process-local cache retains at most 256 entries, serves hits for 60 seconds,
and can show explicitly stale data up to 300 seconds old after failure. Failed
reads have a 15-second retry cooldown. Duplicate concurrent reads coalesce, and
the shared provider budget is 25 requests per 60 seconds with no waiting queue
or background refresh. Each provider call has a five-second timeout. These are
local development limits, not distributed production quotas or a source SLA.
Provider update time remains unknown even for a newly retrieved response.

This route needs no catalogue, price qualification registry, wallet or Uniswap
key. It inherits the loopback/browser-origin boundary below. It does not replace
`/v1/read/pool-metrics`, whose exact ledger/valuation semantics are unchanged.
`feeApr24h` remains null, suggestions and execution remain disabled. See
[live HTTP evidence](../reports/on-demand-market-http-probe-2026-09-09.json) and
[qualification notes](../reports/ON_DEMAND_MARKET_QUALIFICATION.md).

## Uniswap API configuration and readiness

Issue #38 connects session and preview adapters through a disabled
[authenticated onboarding API](../docs/ONBOARDING_API.md). It derives owner from
SIWE, requires CSRF, rechecks revocation/expiry after provider work, and applies
durable IP/account/global quotas. Its separate `onboarding-v1` contract and
worker leave read/session payloads and frontend hooks unchanged. No signing,
deployment or financial authority is enabled.

Issue #36 adds an internal [Uniswap LP position preview](../docs/POSITION_PREVIEW.md)
through `preview_position.py`. Uniswap computes the dependent-token amount for
an existing hookless fixed-fee v4 pool; Domino inspects the prepared mint and
compares its maximum debits with selected budgets. The preview contains no
calldata. It does not initialize a pool, balance tokens with swaps, authenticate
an owner or enable a browser/signing route. Human-price input should use the
official frontend/SDK to obtain canonical spaced ticks.

Issue #34 adds an explicit [owner-funded quote preview](../docs/FUNDING_QUOTE_PREVIEW.md)
through `preview_swap.py`: one bounded, expiring hookless-v4 quote with exact
request/route checks and separate provider/Domino fee semantics. It is internal
only, does not calculate the full LP composition, and returns no executable
payload. No new browser route or frontend integration is enabled.

Open `backend/Configurar Uniswap.command` in Terminal, or run
`backend/.venv/bin/python backend/configure_uniswap.py` interactively. Obtain a
key at the [developer portal](https://developers.uniswap.org/dashboard) and enter
it at the hidden prompt. A successful public pool read precedes an atomic mode
0600 save at ignored `backend/runtime/uniswap-api.json`. Failures preserve any
previous configuration. `--config-file` selects a separate worktree's private
configuration destination. Never place the key in chat or command arguments.

`uniswap_liquidity.py` supports generic pair/fee/tick-spacing/hook pool reads.
The live endpoint returns some decimals as strings; the parser normalizes exact
integers with uint8 bounds and preserves missing metadata. Successful pool_info
access alone is not an authentication audit: it also responded without a key.

The configured [Trading API quote probe](../reports/UNISWAP_TRADING_READINESS.md)
succeeded on Robinhood using router `2.1.1`, numeric chain IDs and no signatures.
Those network-specific values supersede generic examples in the installed
`swap-integration` skill. The [internal quote adapter](../docs/FUNDING_QUOTE_PREVIEW.md)
is now implemented. Its public route, complete user funding plan, service-fee
tariff and financial execution remain separate work.

Historical reference-price work for issue #4 now includes a bounded Chainlink
adapter, publication-block evidence, source-isolated persistence and an explicit
offline analytics policy. See [policy and reproduction](../reports/CHAINLINK_REFERENCE_POLICY.md).
This does not populate the production qualification registry or enable public
TVL/APR, signing or execution. The [VFAT MCP assessment](../reports/VFAT_MCP_ASSESSMENT.md)
records another tested discovery/comparison candidate and its coverage limits.

The legacy `qualify_chainlink.py --store-observations` command requires successful
reference validation for both currencies and rechecks every captured proof header
inside the atomic write gate. Failed validation saves neither currency; original
reasons and old rows remain intact. The report exposes `storage.status`, and a
failed requested save exits nonzero. [Legacy storage and recovery](../reports/LEGACY_CHAINLINK_STORAGE.md)
documents the evidence needed for older rows, retention of idempotent provenance
and the distinction from #52's sliced-checkpoint quarantine.

Issue #23 adds [full-day capacity and resumable acquisition](../reports/PRICE_WINDOW_CAPACITY.md).
The generic engine supports 1,446 exact observations per asset/source window,
including a 300-second lookback. Chainlink acquisition still uses at most 64
rounds per atomic fetch; the separate `collect_chainlink.py` command saves bounded
slices at one immutable snapshot. This is a capacity change, not a production
source qualification or a resampling rule.

The `domain.py` Python core runs locally without dependencies, private keys, chain calls or access to the personal bot. It is the high-precision position reference and exact microdollar scenario engine. The separate `discovery.py` module now provides explicit read-only network qualification as described below. The private web prototype exposes the equivalent cost calculation at `POST /api/v1/compound-preview` and explicit disabled live capabilities at `GET /api/v1/capabilities`.

Input uses three decimal **strings**: `availableFeesUsd`, `positionValueUsd`, `gasUsd`. These values describe a hypothetical balanced-fee case. They are not ERC-20 base units, execution permissions, a swap quote, or a promise of profitable execution.

The cost calculation applies a 2% cut only to consumed fees, uses the entire available balanced-fee amount, and requires that the cut cover gas with a 15% buffer. Policy version 2 removes the inherited 15% liquidity-addition cap; there is no fixed idle allocation. It is one preliminary cost gate; a production scheduler also needs owner-benefit estimation, reliable prices, coherent fresh chain observations, actual token ratios, and simulation. The [reinvestment policy](../REINVESTMENT_POLICY.md) requires comparing direct reinvestment, bounded fee-balancing swaps and waiting; swap economics and execution are not implemented here.

Run `backend/.venv/bin/python -m unittest discover -s backend/tests -v` from the project root for the full backend suite, including ABI/Keccak discovery and FastAPI tests. Use the backend environment installed below; the personal bot's environment is separate. The domain-only suite can still run without dependencies with `python3 -m unittest discover -s backend/tests -p test_domain.py -v`. Shared cases in `web/tests/fixtures/compound-cases.json` verify that the Python and TypeScript implementations agree. `benchmark.py` can evaluate historical rate estimates without copying wallet identifiers into its report:

```sh
python3 backend/benchmark.py --observations /path/to/observations.jsonl --gas-usd 0.25 --output reports/rate-cost-sensitivity.json
```

`schema.sql` is the historical **candidate automation schema**, not an applied production migration. Its sequence/fee-provenance/signer design is separate from the tested session migrations and issue #40's `009_direct_deposits.sql`. Those newer private schemas do not implement public vault automation. RLS does not authenticate wallets: a service must derive owner context from a verified, replay-protected session and use a database role without table ownership/BYPASSRLS. All public session/deposit candidates remain disabled and undeployed.

The web practice workspace uses local browser storage; it is not the multi-user database and must not be described as such. No user wallet identity is uploaded to Sites. The future Python API remains a separate deployment from the preview's Cloudflare runtime.

## Read-only discovery qualification

All `ReadRpc.call_raw` / `call` reads use a named **500,000 gas computation
ceiling** (`DEFAULT_READ_CALL_GAS`). A trusted Python caller can select a lower
profile, from 21,000 to 500,000; neither HTTP input nor token metadata can raise
it. This is an `eth_call` node budget, not a transaction or a wallet charge. There
is no automatic gas escalation, gas-error retry or gas-triggered RPC failover.
The existing request count, response size and total deadline still apply.

Explicit node out-of-gas responses become `rpc_call_gas_limit`; explicit EVM
reverts become `rpc_call_reverted`. Unknown or ambiguous provider failures remain
`rpc_error`. Revert data takes precedence over words in a revert reason, so a
token's `revert("out of gas")` is not presented as a proven budget failure. A
proxy can wrap an inner out-of-gas in an ordinary revert; this cannot be diagnosed
as a gas limit from the returned envelope alone. Raw errors and revert bytes are
never exposed. Known gas exhaustion yields an unavailable token/asset read, with
no claim that its metadata is invalid. Ordinary missing/reverting optional
metadata still permits a partial read, with decimals left unknown.

The offline EVM regression uses a synthetic delegated metadata method with 100
cold storage reads: it fails at the former 150,000 ceiling and succeeds once at
500,000. This supports a broader bounded profile, not every arbitrary contract.
Code existence and readable metadata still do not establish token safety or
execution compatibility. See the [pending contract notice](../docs/READ_GAS_DIAGNOSTICS.md).

`discovery.py` uses a bounded read-only JSON-RPC transport, with no personal-bot imports, config reads, signing, transaction submission or daemon. ABI/Keccak dependencies are pinned in `requirements-readonly.txt`; the existing project `.venv` already provides them. A separate environment can install only those requirements.

`qualify_discovery.py` explicitly probes one Robinhood token. It filters DEX Screener candidates by chain, protocol, version and exact token identity, verifies complete PoolKeys against their full hashes through PositionManager, checks current StateView data and token metadata, and rechecks the same block at completion. This verifies a data identity at one block, not the token's economic safety or automation eligibility.

Example from the repository root (choose a new output filename for each run):

```sh
backend/.venv/bin/python backend/qualify_discovery.py --token 0xab35d04e1ee39c789c4a65d522417b3c7f2e4723 --max-pools 12 --output reports/my-discovery-probe.json
```

Optional `--wallet` or `--position-id` enables balance-read qualification; `--probe-inventory` additionally checks one Blockscout ERC-20 inventory page. The shareable output omits wallet identity and exact balances. `DiscoveryReader.balances` preserves exact base-unit amounts internally and labels its address-list coverage; it does not enumerate every wallet token. No wallet ownership/authentication assertion is made by this public-data probe.

Provider metrics retain their source/retrieval time and are labeled `external_unreconciled`; unknown provider block/time coverage is explicit. APR, suggestions and execution remain unavailable. Empty discovery results do not prove that no pool exists. The PositionManager cache only covers pools it knows, and the provider catalogue has no completeness guarantee. The persistent Initialize catalogue below adds independently indexed keys; full historical coverage and rolling fee/TVL accounting remain required.

The public RPC default is for a bounded development probe, not a production service. A separately configured `DOMINO_DISCOVERY_RPC_URL` can supply a qualified HTTPS endpoint; credentials are not printed or saved to the report. Each CLI run has request/response bounds and writes a new output file only after the block check passes. On failure it leaves prior artifacts intact. There is no retry loop or scheduled polling. Do not expose this CLI's configurable transport directly as a public URL-fetch API.

## Internal local read API

The next slice implements `read_api.py`, `read_service.py` and `inventory.py`. [Live qualification](../reports/READ_API_QUALIFICATION.md) confirms the configured Alchemy account returned 12 ERC-20 candidates and 13 balances including ETH were read on-chain. The Blockscout result above is historical evidence from the first CLI, which still probes Blockscout; the new API uses the optional Alchemy adapter.

Install in a dedicated backend environment from the repository root:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-api.lock
```

`requirements-api.txt` lists direct development dependencies, while `requirements-api.lock` freezes the tested dependency set. No changes to the personal bot's `.venv` are required.

To configure Alchemy, open `backend/Configurar Alchemy.command` in Terminal, or run `backend/.venv/bin/python backend/configure_inventory.py` interactively. Enter only the API key at the hidden prompt. Do not paste a key into chat, source files or command arguments. Both entry points probe the zero address unless you explicitly supply `--position-id` to the Python command. A public NFT owner lookup is not wallet authentication.

The configurator validates RPC chain/deployment links, attempts one inventory page and writes the credential-bearing provider configuration with permissions 0600 beneath the ignored backend `runtime/` directory. A valid RPC can still be saved if inventory is unavailable; the result is printed as a separate fixed status. Existing unrelated, insecure or symlinked configuration files are rejected. The API loads configuration only at startup. Optional `DOMINO_DISCOVERY_RPC_URL` and `DOMINO_INVENTORY_RPC_URL` environment variables take precedence. Inventory URLs must name the Robinhood mainnet Alchemy host; no client request accepts provider URLs.

Start the local API:

```sh
backend/.venv/bin/python backend/read_api.py --port 8876
```

Stop it with Ctrl+C. Port 8765 belongs to the existing personal dashboard and is not used here. The development launcher accepts no external bind address, disables access logs, rejects browser origins and has no CORS integration. Do not connect the published UI directly to it or treat it as a public production service.

| Route | Purpose |
|---|---|
| `GET /health` | Process liveness only; does not claim provider health |
| `GET /v1/capabilities` | Explicit local/read-only capabilities and inventory configuration status |
| `POST /v1/read/wallet-assets` | Public-address balance reads with optional indexed candidate page and address fallback |
| `POST /v1/read/token` | Standalone contract-address metadata lookup, independent of wallet inventory and pool providers |
| `POST /v1/read/pools` | Catalogue/provider candidate discovery and pinned-block verification, optionally filtered by pair |
| `POST /v1/read/catalogue` | Stored public pool candidates, both currencies, provenance and revision-bound pages |
| `POST /v1/read/pool-activity` | Indexed core events, rolling swap legs, active liquidity, qualified trading fees and historical freshness |
| `POST /v1/read/pool-positions` | Qualified per-core-position principal and unsettled fees, plus pool-attributed aggregates |
| `GET /openapi.json` | Validated request contract; interactive docs are disabled |

Wallet request fields are `wallet`, up to ten `tokens` contract addresses, optional boolean `autoDiscover` and optional `cursor`. Native ETH is always queried. Keep the same wallet and fallback list when using the returned `inventory.nextCursor`. Cursors expire after five minutes or a server restart. Retain a failed page's input cursor for retry; `hasMore: null` means unknown, whereas `false` means the provider reported no next page. Each page's balances have their own block snapshot. Merge visible rows by chain/currency address, not symbol, without pretending all pages share one block.

The response includes raw integer-string amounts, optional decimals/symbols, unavailable-token reasons, inventory coverage and snapshot freshness. Zero is an observed quantity; unavailable is not zero. Candidate metadata or indexed balances never authorize execution. Rendering token text must remain escaped; no provider logos or metadata URLs are fetched. APR and automatic suggestions remain unavailable.

Pool requests contain `token`, optional `pairedToken`, integer `maxPools` from 1 to 20 and optional `poolIds` containing at most ten full 32-byte identifiers, with no more IDs than `maxPools`. Explicit IDs are verified first and must contain the selected currencies. A configured catalogue automatically supplies known PoolKeys, so no user-facing identifier is required to find those pools. The two selected currencies must differ. Provider-only candidates remain a fallback and are not written by this reader API. Neither source establishes complete pool coverage.

Known chain-read failures return 503 with a safe error code; invalid/expired inventory cursors return 400, changed catalogue revisions 409, invalid fields 422, busy reads 429 and oversized bodies 413. Pool-provider failure instead returns a usable token lookup with `discovery.status: unavailable`, null candidate counts and any directly verified pools; an empty successful provider response has `status: received` and a zero count. A catalogue outage preserves provider fallback with `catalogue.status: unavailable`. None proves no pool exists. One expensive read runs at a time, with at most one start per second; honor `Retry-After`. These limits are process-local. UI cache preservation, distributed rate limiting and qualified valuation history remain unimplemented.

`qualify_read_api.py` can reproduce a bounded live HTTP test using `--position-id`, repeated `--token`, optional `--pool-token`, a bounded `--max-pages` and a new `--output` filename. Run it only while the local API is running. Its shareable artifact omits wallet identity, quantities and provider credentials. The API itself returns public quantities to its local caller; these are not authenticated private account records.

## Generic token handling — API 0.2.0

The runtime has no MARLIN, stablecoin, or token-address admission list. A request supplies the contract address. The committed Robinhood matrix is a test fixture, not runtime configuration or a list of recommended assets. The chain and trusted Uniswap deployment addresses remain fixed to the approved Robinhood scope.

`POST /v1/read/token` accepts only `token` and returns `asset` plus its checked block snapshot. No wallet or DEX Screener call is required. `readStatus` distinguishes `available`, `partial`, `no_contract` and `unavailable`. A contract with readable metadata is labeled `erc20_candidate`, not a certified ERC-20 or an admitted automation asset. A contract can imitate these methods; the read path does not test transfers, rebase behavior, taxes, hooks or swap compatibility.

ERC-20 decimals and symbols are optional. If decimals are absent or invalid, the API returns `decimals: null` and `displayUnitsAvailable: false`; a successful `balanceOf` still returns its exact `amountRaw`. Do not divide that value by an assumed precision or use it for human-denominated deposit quotes. Zero decimals is valid and remains distinct from missing decimals. Symbols support both standard ABI strings and legacy bytes32 using one pinned call; missing, invalid or oversized text never replaces contract identity. Treat returned text as untrusted display content.

Wallet and pool envelopes now have `schemaVersion: 2` to signal the candidate-kind and metadata-state changes; the new standalone token envelope starts at version 1. Token metadata failure no longer removes an otherwise verified pool identity. Each pool exposes `tokenMetadataStatus`, while execution, APR and suggestions stay unavailable.

To reproduce the broader HTTP matrix against a running local API:

```sh
backend/.venv/bin/python backend/qualify_token_matrix.py --manifest backend/tests/fixtures/robinhood-token-matrix.json --output reports/my-generic-token-probe.json
```

It probes at most twelve public cases and five pools per case, with a bounded explicit-ID fallback and pauses that respect the API's start limit. Its optional balance checks use the public zero address, not the user's wallet, and omit quantities from the artifact. The JSON includes actual pool IDs, per-request block/hash and coverage limits. It does not claim all pools or tokens on Robinhood were verified.

See [ERC-20 metadata requirements](https://eips.ethereum.org/EIPS/eip-20) for the optional name/symbol/decimals fields. Supporting incomplete read metadata does not relax the approved transaction-compatibility rules.

## Persistent public catalogue — API 0.3.0

`catalogue.py` and `catalogue_indexer.py` add PostgreSQL pool identities, both currency mappings, atomic chunks/checkpoints and rollback/replay for confirmed block changes. `migrations/001_catalogue.sql` is applied only to the public catalogue; the private-account `schema.sql` remains a candidate. The measured [qualification](../reports/CATALOGUE_QUALIFICATION.md) records 217 pool identities, 135 currency addresses, restart/restore tests and automatic cross-currency HTTP lookup. Coverage is partial and exposed explicitly.

Install PostgreSQL 16 or newer with its server and client binaries (macOS Homebrew or Linux). The helper discovers Homebrew, `pg_config`, PATH and Debian/Ubuntu installations. Set `DOMINO_PG_BIN` to an explicit bin directory if needed. Existing data must use the same PostgreSQL major version; the helper never upgrades it. Local qualification used PostgreSQL 18; CI checks Linux PostgreSQL 16. Windows development uses WSL2. This is separate from the proposed production deployment.

Start the task-local database, then the local API in a second terminal:

```sh
backend/.venv/bin/python backend/dev_postgres.py start
backend/.venv/bin/python backend/read_api.py --port 8876
```

The helper creates/reuses `runtime/postgres`, a private Unix socket under `runtime/pgsocket` and a 0600 database descriptor. Port 8877 identifies the Unix socket; **TCP listening is disabled**. Local trust authentication is limited by the private filesystem directory, not wallet identity. It does not provide isolation from code running as the same OS user. The reader has SELECT grants; the writer has DML grants and takes a PostgreSQL advisory lock. No startup service or indexing schedule is installed.

To prepare the disposable databases and run the PostgreSQL-backed suite (the optional EVM checks are described below):

```sh
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 backend/.venv/bin/python -m unittest discover -s backend/tests -v
```

Without that environment flag the PostgreSQL cases are explicitly skipped. Those cases reset only `domino_catalogue_tests` and restore backups only into `domino_catalogue_restore_tests`; they never truncate the populated `domino_catalogue` database. The restore test includes records, checkpoints and grants. These are public-catalogue checks, not private-tenant RLS checks.

`manage_catalogue.py seed --report PATH` accepts a bounded discovery report or token-matrix report. It validates complete keys, rechecks all supplied pools at one fresh chain block and rechecks that block before storing observations. A seed does not claim contiguous event coverage. For example:

```sh
backend/.venv/bin/python backend/manage_catalogue.py seed --report reports/generic-token-qualification-2026-09-09.json
```

For a new catalogue, choose an explicit historical starting block. This reproduces the qualified interval and writes a new report filename:

```sh
backend/.venv/bin/python backend/manage_catalogue.py index --start-block 58736592 --through 58742591 --span 1000 --max-steps 6 --output reports/my-catalogue-index.json
```

An existing index keeps its start and resumes from its stored checkpoint. Omit `--start-block` on subsequent runs. Omitting `--through` targets the observed head minus 200 blocks, but work remains bounded by `--max-steps` (1–50). This lag is a development margin, not settlement finality. Log queries span at most 1,000 blocks; request-count, response-size and decoded-event limits fail the current chunk without clearing earlier progress. A failure after previous chunks committed can therefore leave useful progress even if the overall command fails. Use a new output filename per run.

`POST /v1/read/catalogue` accepts `token`, optional `pairedToken`, `limit` (1–100), `afterPoolId` and `revision`. Keep the same pair filters when paging. An `afterPoolId` requires the previous page's revision; a change returns 409, so restart the list. Results carry `startBlock`, `indexedThrough`, `completeHistory: false` and source observation blocks. `mode: stored_catalogue_candidates` means identities are stored candidates, not freshly verified state.

`POST /v1/read/pools` loads at most 100 catalogue candidates for the selected token/pair and checks at most 20 pools. Explicit IDs take priority, then catalogue entries, then provider entries. PoolId ordering is deterministic, not a quality score. A valid full key bypasses the PositionManager cache but still requires current StateView verification and block consistency. Retain `hasMore`, `notProbed`, revision and provenance when consuming the response. For a larger catalogue, browse its pages and request selected IDs for fresh validation.

Reproduce the cross-currency HTTP check while the local API is running:

```sh
backend/.venv/bin/python backend/qualify_catalogue.py --token 0x0bd7d308f8e1639fab988df18a8011f41eacad73 --paired-token 0x5fc5360d0400a0fd4f2af552add042d716f1d168 --expected-pool-id 0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6 --output reports/my-catalogue-http.json
```

The expected ID is an assertion in the qualification tool; it is not sent to the API. All addresses in this example are public test data, not a runtime token list. The API and indexer use the locally configured Alchemy endpoint without exposing its credentials. This slice has no wallet reads, signer, transfer, approval or fee-collection action.

Stop the API with Ctrl+C. Stop only this task's PostgreSQL cluster with:

```sh
backend/.venv/bin/python backend/dev_postgres.py stop
```

Stopping retains the stored catalogue. The qualification servers are stopped after checks; start them explicitly for further local integration. API responses and capability flags do not imply continuous indexing, complete historical coverage or published-UI connectivity.

## Core pool activity — API 0.4.0

The activity worker stores `Initialize`, `Swap`, `ModifyLiquidity`, `Donate` and `ProtocolFeeUpdated` events for one selected pool. It reconstructs range liquidity and checks ending price, tick, protocol rate and active liquidity against StateView before committing a chunk. `migrations/002_activity.sql` adds a separate public schema; the local PostgreSQL helper applies the public migrations. The private-account schema and personal bot remain separate.

The [qualification report](../reports/ACTIVITY_QUALIFICATION.md) records two live pools, exact swap quantities, zero-activity handling, process resume and real database tests. The [methodology](../METRICS_METHODOLOGY.md) defines the rolling interval and explains the remaining fee/TVL accounting requirements. This layer provides core event activity, **not qualified USD volume, TVL or APR**.

Start or update the local database with `dev_postgres.py start`. Use `prepare-tests` instead when preparing the fixed disposable test databases. The activity reader is part of `read_api.py` on port 8876 and retains the same loopback-only boundary and request gate.

Index a catalogued pool from its verified initialization, using a new output filename:

```sh
backend/.venv/bin/python backend/manage_activity.py --pool-id 0xc613d796ce23c7344334ac5373063c89479675876d25738ee78cf0642f2a30ef --through 58748260 --span 5000 --max-steps 2 --output reports/my-activity-index.json
```

This PoolId is a public qualification example, not a runtime admission list. A pool present in the Initialize catalogue can supply its starting block automatically. A pool known only from a verified observation needs an explicit `--initialization-block`; the worker checks that exact block's Initialize event before registering it. A guessed block is not accepted. Full-history backfill for older or high-activity pools still needs archive capacity and operational qualification.

Subsequent commands resume the stored checkpoint. `--through` defaults to the observed head minus 200 blocks. Each run permits 1–50 steps and spans of 1–10,000 blocks per filtered log query. Additional bounds are 2 MB per response, 2,000 events per chunk and 300 RPC requests per worker instance. The default activity profile permits 5,000 **live** aggregate ranges (zero-liquidity ranges are removed); `manage_activity.py --capacity-profile extended` permits 10,000. After a range overflow, `--status` reads its persistent operator diagnostic without RPC, and selecting extended retries the uncommitted interval from the retained checkpoint. The selected limit also checks inherited models, including empty intervals. Reducing the span can address dense intervals, but cannot fix a simultaneous range ceiling or a single block over the event ceiling. Earlier successful chunks survive a later error. No indexing loop or startup service is installed by this command. See [historical capacity and recovery](../docs/HISTORICAL_CAPACITY.md#resume-an-activity-range-overflow) for commands, limitations and the independent downstream profiles.

Fee, position and capital workers explicitly select `--activity-capacity-profile extended` when replaying an extended source model. This does not enlarge their independent position/tick profiles or qualify their financial values automatically. A resource failure retains the last complete prefix and leaves the affected current metric unavailable; no partially replayed totals become public data.

The activity stream's checkpoint is independent of the catalogue's global Initialize checkpoint. Extending one pool's history does not extend the catalogue or other pools. Events preserve transaction/log identity, block timestamp, ABI values, sender and position salt for later accounting. API summaries omit the individual event senders and position salts.

`POST /v1/read/pool-activity` accepts only `poolId`. It returns:

- PoolKey, methodology/revision and indexed block snapshot.
- `window24h`: exact per-currency gross inputs, outputs, turnover, swap counts and donations in `(asOf − 86400, asOf]`.
- Initialization age and `completeWindow`, with `pool_younger_than_window` for a short history.
- Reconciled core active liquidity, range count and raw fee-growth diagnostics. Active liquidity is explicitly not TVL.
- A fresh RPC check of the stored hash plus snapshot age. `usableAsCurrent24h` requires complete coverage and a snapshot no older than 120 seconds.

Unknown streams return `activity_pool_not_registered`; registered streams with no committed history return `activity_not_indexed`. RPC failures and orphaned snapshots are unavailable responses, never zero activity. A valid historical response can be stale. Do not relabel its requested 24h window as a complete current day of data. USD volume, APR and TVL remain null with specific reasons; recommendations and execution remain disabled. API 0.5.0 can populate trading-fee quantities through the separate qualification step below.

## Core trading fees — API 0.5.0

`fee_accounting.py` reconstructs swap-step LP/protocol allocations and donation growth using `v4_math.py`. `fee_store.py` reconciles the results against historical StateView before committing independent versioned checkpoints. It supports hookless fixed-fee accounting without a token admission list. Other pools keep their activity reads with `fee_accounting_adapter_required`. See [methodology](../METRICS_METHODOLOGY.md) and [qualification](../reports/FEE_ACCOUNTING_QUALIFICATION.md).

Apply the public migrations with `dev_postgres.py start`, then qualify existing activity. This example performs bounded reads of public chain state and PostgreSQL writes, without transactions:

```sh
backend/.venv/bin/python backend/manage_fees.py --pool-id 0xc613d796ce23c7344334ac5373063c89479675876d25738ee78cf0642f2a30ef --max-steps 6 --output reports/my-fee-ledger.json
```

The worker advances one existing activity chunk in bounded batches, up to 50 batches per invocation. A batch processes at most 32 of the chunk's 2,000 events and shares a 100,000-step simulation budget across every candidate attempt. The 8,192-step limit per candidate remains unchanged. A complete-event prefix can be saved without publishing fee totals; a new invocation resumes the next event inside the same stored chunk. Only full replay, growth/state reconciliation and canonicality checks publish the chunk. A single event beyond the simulation limit remains unsupported. See [historical capacity and recovery](../docs/HISTORICAL_CAPACITY.md) for exact resume commands and durable diagnostics. The worker neither creates an activity stream nor schedules itself. Activity reorg recovery cascades through published and unpublished derived work; network errors preserve the last good checkpoint.

`fees.accounting.status: reconciled_as_of` enables exact `window24h.lpFeesRaw` and `protocolFeesRaw`, both ordered currency0/currency1. Cumulative amounts are under `fees.accounting`. These are trading-fee allocations before Q128 distribution rounding, not per-position collected balances or Domino service fees. Missing/behind ledgers return null, while a fully reconciled zero-swap interval returns zero. An API read still rechecks block canonicality and marks freshness independently. Updating activity requires another fee qualification before new totals become available.

Run the complete backend suite including PostgreSQL and the independent original-v4 EVM reference:

```sh
node scripts/test-contracts.mjs --match-path test/reference/OfficialDominoCompound.t.sol
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -q
backend/.venv/bin/python backend/dev_postgres.py stop
```

The contract command also builds the pinned official fixtures and V3 artifacts
needed by the new compound receipt tests. Those tests deploy on a separate local
chain 4663 and verify actual ERC20/native receipts; this local chain ID is not a
Robinhood fork or mainnet qualification. Backend CI performs the same build in
its own checkout and cannot depend on artifacts from the separate Contracts job.

The EVM test uses the existing pinned local compiler and Anvil binary, a temporary loopback port and chain 31337, with no fork. It compiles a non-production harness, checks 1,024 swap steps, 128 tick roundtrips, four trading-fee Pool sequences and the additional position sequence described below, then stops Anvil. Recorded vectors and upstream hashes are also checked without EVM access. API 0.6.0 passes 161 tests, including 49 PostgreSQL tests and three EVM test methods. No dependency was added to the runtime environment. Supply `--require-fees` to `qualify_activity.py` to require reconciled values during HTTP qualification.

The read query processes at most 50,000 swap/donation events within the window. It returns aggregate raw units, not token decimal conversions or a per-user earnings ledger. The two currency turnover values are two legs of the same trades and must not be added as USD volume. Protocol updates apply in event order; donations and zero-delta fee pokes do not count as swaps.

Run a bounded live HTTP check against a running local API:

```sh
backend/.venv/bin/python backend/qualify_activity.py --pool-id 0xc613d796ce23c7344334ac5373063c89479675876d25738ee78cf0642f2a30ef --pool-id 0xb267aed771add477cec491761b7001ebe2a179fa0e675a76df47ae0ec064230a --output reports/my-activity-http.json
```

The output omits user-wallet queries and contains public aggregate data only. Stop the API and task-local PostgreSQL with the commands above after local qualification; stored history is retained. No web publishing or connection to the personal dashboard is part of this slice.

## Core positions and asset accounting — API 0.6.0

`position_accounting.py` reconstructs core position identity, liquidity, tick outside growth, fee debt/settlement, principal and LP-attributed token flow. `position_store.py` verifies every known core position, distinct range and tick at the same historical block before persisting the versioned checkpoint and modification journal. `004_positions.sql` adds public derived tables dependent on qualified fee chunks. It does not apply private account schemas or resolve NFT ownership. [Methodology](../METRICS_METHODOLOGY.md) and [qualification](../reports/POSITION_ACCOUNTING_QUALIFICATION.md) define the accounting and its limits.

Run activity indexing, fee qualification, then position qualification. Applying migrations alone never marks old records qualified:

```sh
backend/.venv/bin/python backend/dev_postgres.py start
backend/.venv/bin/python backend/manage_positions.py --pool-id 0xc613d796ce23c7344334ac5373063c89479675876d25738ee78cf0642f2a30ef --max-steps 6 --output reports/my-position-ledger.json
```

The default `standard` capacity profile retains 128 lifetime core identities and 256 known boundaries per pool. The trusted CLI also accepts `--capacity-profile extended`, bounded to 1,024 identities and 2,048 boundaries. Closed positions and cleared ticks retain their accounting and reconciliation records. Event replay advances in the same bounded batches as the fee worker; position/range/tick reconciliation makes at most 128 proof calls per batch, within 160 total RPC calls and a 90-second transport budget. Batches resume across worker instances and invocations. Only the completed proof publishes the chunk, with the same conservation and settlement audit gates. The CLI takes at most 50 batches and installs no daemon. A failed read preserves checkpoints; source activity rewind removes orphaned published and unpublished work. A newer activity tail requires fresh fee and position qualification. [Historical capacity and recovery](../docs/HISTORICAL_CAPACITY.md) describes profile selection, persistent failure reasons, stored-chunk resume and the independent capital/NFT-read limits.

The activity response adds aggregate `liquidity.positionAccounting`. The `/v1/read/pool-positions` route accepts only `{poolId}` and returns the same snapshot/canonicality/freshness information plus bounded individual core records. Unqualified direct position requests return 503 with a safe reason; the activity route keeps its narrower available data. Core owner identifies the PoolManager caller, often PositionManager, and salt remains opaque in the base ledger. API 0.7.0 adds a separate official-manager NFT adapter on the individual position route, described below. It does not establish a wallet balance or a valid withdrawal transaction.

Amounts satisfy `lpAssetsRaw = principalRaw + unsettledFeesRaw + roundingResidualRaw` separately for currency0 and currency1. Protocol allocations are excluded, donations are included, and previously settled fees are accounted for at each modification. Principal flows describe gross core additions/removals, including additions funded by accrued fees; they are not investor deposits, withdrawals or P&L. USD TVL and fee APR remain null pending valuation and complete time-weighted history.

Against a running API on 8876, qualify actual HTTP amounts and per-position/aggregate sums:

```sh
backend/.venv/bin/python backend/qualify_positions.py --pool-id 0xc613d796ce23c7344334ac5373063c89479675876d25738ee78cf0642f2a30ef --pool-id 0xb267aed771add477cec491761b7001ebe2a179fa0e675a76df47ae0ec064230a --output reports/my-position-http.json
```

The saved artifact omits individual core owners and salts. The native reference test adds a 20-event sequence with three positions, fee pokes, partial removal, closure and reopening. Golden state/settlement vectors are checked on every ordinary test run; set `DOMINO_TEST_EVM=1` to also run the original compiled Pool/Position implementation. The full-suite command above runs both layers. Qualification processes can be stopped after testing; public history remains stored.

## Event-time capital, prices and NFT ownership — API 0.7.0

`005_capital_prices.sql` adds public capital checkpoints, after-event asset records and external price observations; `012_capital_work.sql` extends 007's unpublished work table to capital. Apply them with the existing `dev_postgres.py start` command. Run activity, fee and position qualification to the same tail first. The capital worker reconstructs at most 32 events and performs at most 128 position/range/tick checks per batch, verifies the ending full model and canonical source, then commits the whole capital chunk atomically. It processes existing chunks and does not fetch missing pool activity or install a scheduler. Select `--capacity-profile extended` for up to 1,024 lifetime identities / 2,048 known ticks, including later empty chunks. The default remains 128 / 256. [Capital-specific recovery](../docs/HISTORICAL_CAPACITY.md#capital-specific-resume-and-recovery) documents method/source-bound checkpoints, explicit reviewed restart and the finite invocation limits.

```sh
backend/.venv/bin/python backend/manage_metrics.py --pool-id 0xc613d796ce23c7344334ac5373063c89479675876d25738ee78cf0642f2a30ef --max-steps 8 --fetch-prices --output reports/my-capital-prices.json
```

An unfinished capital invocation reports `capitalLedger.status: in_progress` with its diagnostic, `result: null` and no price acquisition; repeat with a new report filename. Once capital catches up, `--fetch-prices` uses the locally configured Alchemy credential with Alchemy's historical-prices endpoint. It never prints the credential or accepts a provider URL from HTTP. At most two price requests cover the measured interval plus a five-minute boundary margin. A provider error leaves existing price/capital history intact. Observation identity, timestamp, provenance and revisions are validated. Conflicting past prices require review rather than an automatic overwrite.

In the actual qualification, native ETH returned 12 observations. Address queries for the sample's three ERC-20s returned HTTP 400; the bounded network diagnostic identified Robinhood as unsupported by the prices endpoint. RPC/inventory support is separate. **No production price source is qualified.** The empty internal qualification registry cannot be populated by price JSON or a public request. Target-pool independence, price bucket semantics, currency identity/decimals and full coverage require a reviewed source adapter before the conditional engine produces live dollar metrics. There is no stablecoin peg or symbol-based ERC-20 fallback.

New local HTTP routes:

| Route | Body | Result |
|---|---|---|
| `POST /v1/read/pool-metrics` | `{ "poolId": "0x…" }` | Reconciled capital, exact raw-unit time integrals, observation diagnostics, and conditional USD TVL/volume/fee APR with snapshot freshness. |
| `POST /v1/read/nft-positions` | `{ "tokenIds": ["2235738"], "blockNumber": 58800000 }` | Pinned official PositionManager NFT identity, actual owner, core principal and unsettled fees. Omit `blockNumber` for a fresh head. |
| `POST /v1/read/pool-positions` | `{ "poolId": "0x…" }` | Existing core records plus an `nft` resolution object at the stored historical block. Custom core callers require an adapter. |

Token IDs are one to ten unique uint256 decimal strings, preserving values beyond JavaScript's safe integer range. A failed owner read returns an error; it is not treated as a burn. Cleared metadata, zero-liquidity but owned NFTs and unsupported core callers are distinct. A changed owner is reread on each fresh request. Past settled fees are never assigned to the current owner. These are public reads: no wallet authentication, NFT inventory enumeration, transfer journal, private accounts, approvals or financial execution are implemented by this revision.

The capital convention is post-event balance held until the next event timestamp; same-second events are processed in block/log order, with zero elapsed time between them. Prices use qualified causal observations and bounded age, with no future interpolation. The denominator is the time-weighted average of LP-attributed assets including unsettled fees/residual and excluding protocol allocation. The numerator is LP trading fees over the identical trailing day. Younger pools and zero denominators have no APR. [Methodology](../METRICS_METHODOLOGY.md) defines these choices and current limits.

Qualification against a running loopback API:

```sh
backend/.venv/bin/python backend/qualify_metrics.py --pool-id 0xc613d796ce23c7344334ac5373063c89479675876d25738ee78cf0642f2a30ef --pool-id 0xb267aed771add477cec491761b7001ebe2a179fa0e675a76df47ae0ec064230a --token-id 2235738 --output reports/my-capital-nft-http.json
```

The [qualification report](../reports/CAPITAL_PRICES_NFT_QUALIFICATION.md) records 200 passing tests, including 61 PostgreSQL tests and the three original-v4 EVM methods. New cases cover exact hand-calculated daily APR, sparse price changes, mid-interval gaps, no lookahead, raw precision, same-second ordering, full-day capital boundaries, atomic resume/reorgs, backup/restore, NFT transfers, cleared metadata, strict ABI identity and HTTP boundaries. The real samples retain 3,438 and 1,008 seconds of history at their stored snapshots; they are not complete current 24h analytics. No web or personal-bot changes are part of this milestone.

## Price diagnostics: qualification and coverage

In `/v1/read/pool-metrics`, each `prices[]` entry has additive `sourceQualification` and `coverage` fields. Source approval is distinct from available observations. The combined `status` is `qualified` only when an approved series covers the entire requested interval and both endpoints. No stored data yields `unavailable` / `price_history_missing`; a qualified series with a gap yields `unavailable` / `qualified_price_coverage_gap`.

`sourceQualification` is `qualified`, `unqualified` or `not_assessed`.
`observations` and `observedSources` are nullable: a successful load returns an
exact count and source list (including `0` and `[]` for missing history). A
currency over the bounded window returns `status: unavailable` and
`reason: price_observation_budget_exhausted`, with null count, source list and
timestamp extrema, and `not_assessed` source qualification/coverage. It never
reports truncated or invented counts. The other currency keeps its own observed
or qualified diagnostics. Unqualified observations use
`price_source_quality_not_qualified`; any overflow keeps all pool USD/APR fields
null without discarding verified capital, snapshot or revision.

`coverage.status` is `complete`, `incomplete`, `missing` or `not_assessed`; its `startTimestamp`, `endTimestamp` and `maxAgeSeconds` explain the interval and policy. Unqualified data never claims complete coverage. Frontend adapters should preserve this distinction alongside the enclosing snapshot's freshness and the separate `valuation` result. See [methodology](../METRICS_METHODOLOGY.md) and [provider readiness](../reports/PRICE_SOURCE_READINESS.md). No production price qualification is enabled by this change.


### Completed price collections and reviewed orphan recovery

A completed `collect_chainlink.py --store-observations` invocation rechecks its
canonical snapshot, slice boundaries and publication proofs even when no new
slice is acquired. Verification failure leaves storage unchanged. Known moving
price-window capacity returns metrics with verified capital preserved and USD
null, using the existing read-v1 #26 unassessed state. Previously stored orphan
proofs require explicit operator-reviewed quarantine with a durable private
archive; collection retries never overwrite/delete them. See the bounded
[workflow and evidence](../reports/PRICE_WINDOW_CAPACITY.md#moving-window-and-orphan-recovery--issue-51).

## Disabled browser read bridge candidate — read-v1 1.1.0-rc.3

The nine browser candidates now share strict success/error models in
`read_contract.py`, exported schemas/types/fixtures in `api-contracts/read-v1/`,
and generated local OpenAPI. Run both exporters with `--check` in CI; omit that
flag to regenerate after a reviewed model change. Historical local-only routes
are not automatically enabled in the browser.

`read_gateway.py` is a separate disabled loopback process. It verifies Access
service JWTs, enforces central admission/IP budgets, validates reader output and
exchanges internal inventory cursors for short-lived opaque handles. It cannot
sign or authenticate a wallet. `bridge_http.py` restricts transport to numeric
loopback with a total socket deadline; `read_deadline.py` shares the reader's
remaining budget across nested provider work. A failed browser request does not
release actual reader work; health reconciliation prevents another operation
until the reader is idle.

See the [gateway runbook](../docs/READ_GATEWAY_RUNBOOK.md) for explicit disabled
startup and the separate credential/staging phase. Existing localhost/browser
restrictions stay enabled. No changes to local personal-bot services are needed.

## Multiple read RPC providers — issue #24

For the node on clawber, use the [local RPC integration](../docs/LOCAL_RPC_SOURCE.md):
`configure_rpc.py --local` creates version 3 with separate current, historical
and Alchemy sources. The token stays in each service's private configuration;
the existing browser bridge inherits the backend's current data source.

The local configuration separates generic RPC endpoints from Alchemy inventory.
Version1 files remain readable and retain their shape. They now allow either the
known Alchemy RPC shape or the public Robinhood default in `rpcUrl`. Inventory
continues to use its own Alchemy validator. Field errors identify `rpc_url`,
`rpc_fallback_url` or `inventory_url` without echoing an endpoint or credential.

Version2 adds `rpcFallbackUrls` (at most two) and `rpcAllowedHosts` (at most eight
exact, lowercase DNS names); `rpcUrl` remains the primary for compatibility with
local audit tools. `inventoryUrl` can be null. All URLs must be HTTPS with no
userinfo, query, fragment, explicit port or browser-selected destination. Defaults
include the public Robinhood, Alchemy and exact `rpc.domino.money` hosts. An operator can add a new
provider by local configuration, without relaxing inventory admission or editing
code. Host admission is not evidence of chain/provider qualification.

```sh
backend/.venv/bin/python backend/configure_rpc.py
```

The terminal asks for one to three full URLs through hidden input, preserves the
inventory setting, verifies the chain/managers and common block on every endpoint,
and saves only after all probes succeed. No endpoint or key is a command-line
argument. The existing Alchemy configurator preserves the independent RPC list
in version2 files when rotating an inventory key. With a version1 file, that
configurator replaces the primary RPC with the new Alchemy endpoint. Upgrade to
version2 first to preserve a separate public RPC. Neither configurator is run
automatically.

The product read API uses the ordered RPC list. Each logical read tries an
endpoint at most once, advances on network errors or HTTP429/502/503/504, and keeps
one deadline and request counter, including failed attempts and verification.
The fallback verifies chain4663 and every previously observed block before reading
state. Wrong chain or changed snapshot rejects the entire result, even if an
optional metadata handler catches the initial error. Contract reverts, invalid
RPC/ABI and budget exhaustion do not trigger provider retries. State reads must
use an already observed numeric block. No results from an inconsistent snapshot
are mixed into a response.

`DOMINO_DISCOVERY_RPC_URL` is a trusted, validated single-endpoint override and
intentionally disables configured fallbacks for that process. Legacy historical
CLI tools still use `rpcUrl` as their primary; this slice enables automatic
failover in ReadService/API only for legacy configurations. Version 3 historical
tools use `historicalRpcUrl`; Alchemy-only consumers use `inventoryUrl`.
Public response shapes and field names are
unchanged. Staging must qualify an independent secondary endpoint and exercise
outage/identity failure before claiming deployed redundancy.

## Nine-route read contract candidate

The public response boundary projects known unpublished fee/position work into
the existing unavailable/null ledger states. Replay/proof progress, work awaiting
method review, dependency waits and finite capacity exhaustion retain
`fee_ledger_not_caught_up` or `position_ledger_not_caught_up`, including the fee
window reason. Stored RPC/network/database failures return sanitized 503/504
errors instead of ordinary incomplete history. Raw operator reports retain
`historicalWork`; snapshots, revisions
and independently qualified amounts are unchanged. Unknown diagnostics, source
or checkpoint inconsistencies, nonnull unqualified amounts and canonical failures
remain errors. Capital reads validate pending position and capital sidecars before calling
them missing history. Ambiguous missing-chunk diagnostics require a current
methodology check of that exact dependency. The updated manifest pins the producer and request validator.

ReadService exports `read-v1 / 1.1.0-rc.3` through the local API and disabled
same-origin gateway/BFF. Catalogue, pool activity, core positions and historical
metrics now use validated response models, in addition to the original five routes.
Public reads require no SIWE; a real authenticated service caller mediates browser
requests while the reader's Origin boundary remains enforced. See the
[change notice and remaining evidence gates](../docs/READ_CONTRACT_CANDIDATE_1_1.md).
