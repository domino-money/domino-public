# Domino

Private source repository for a wallet-friendly Uniswap v4 liquidity app on Robinhood Chain. The approved alpha includes self-compounding and Domino successor positions. The product UI is English, playful and modern with restrained retro details.

## Current status

- **Invited-wallet candidate:** operator-managed backend allowlist for login/private operations, with revocation and generation-bound sessions. Public reads stay open. [Wallet access](docs/WALLET_ACCESS.md), [home VM handoff](docs/HOME_VM_RUNBOOK.md). Application disabled; VM/database foundation provisioned, no real wallets admitted.
- **Web:** approved Tangerine practice workbench, position/activity cards, modal workflows and hypothetical fee calculations. Browser-local practice data; no live deposits or signing.
- **Backend 0.8.0:** generic token reads, verified pool identities and on-demand provider TVL/24h volume/hourly prices with a bounded cache. Exact historical accounting and NFT ownership reads remain available separately.
- **Market data:** attributed provider TVL/volume can be read without a local pool ledger. Reconciled USD valuation and LP fee APR remain unavailable without qualified inputs. Source coverage, method and freshness remain visible; no new-pool history is invented.
- **APR calculation candidate:** separate local pool-estimate and managed NFT/sequence fee calculators, with reproducible examples and a current VFAT source assessment. Existing read fields and frontend feeds are unchanged; the managed collector remains pending. [Methods and handoff](docs/APR_METRICS.md).
- **Read bridge candidate:** shared `read-v1` contract, disabled same-origin Worker and authenticated loopback gateway; offline validation only. [Runbook](docs/READ_GATEWAY_RUNBOOK.md) and [evidence](reports/READ_BRIDGE_IMPLEMENTATION.md).
- **Wallet sessions candidate:** disabled SIWE backend with private PostgreSQL state and a separate session BFF; plain EOAs only. [Session runbook](docs/WALLET_SESSIONS.md). No frontend hookup or deployed login.
- **Direct-deposit candidate:** durable owner-bound operations, one wallet-signed step at a time and verified receipts/NFT identity for admitted existing v4 pools. [Deposit runbook](docs/DIRECT_DEPOSITS.md). Disabled; no server signing/broadcast or public activation.
- **Reviewed-token support:** WETH/USDG proxy profiles, fresh identity/state checks and explicit receipt amount bases in the disabled deposit candidate. Four deposit paths observed on a local Robinhood fork with the reviewed profiles. [Evidence and remaining gates](reports/UPGRADEABLE_ADMISSION_IMPLEMENTATION.md). No public activation or mainnet transactions.
- **Contracts:** the [seven-component public Domino V1 release](contracts/README.md) retains technical implementation version 4 and implements owner-bound immutable clones, typed self-compound/netting/successor actions, owner-funded Setup and independent recovery. Local official-v4 and adversarial tests support review; no public financial deployment, signing or swaps are enabled. The V3 candidate was retired on 20 September 2026. The [V4 remediation](reports/V4_REMEDIATION_2026-09-21.md) and [M1/M2/M3 corrections](reports/V4_M123_REMEDIATION_2026-09-21.md) document the internal bases; use the [public V1 build and unsigned release procedure](docs/FINANCIAL_RELEASE.md) for current deployment artifacts and pins.

The personal live bot, operator wallet, credentials and operational database are outside this repository. See [implementation status](IMPLEMENTATION_STATUS.md), [alpha scope](ALPHA_SCOPE.md) and [security specification](SECURITY_SPEC.md).

The approved [MVP data strategy](MVP_DATA_STRATEGY.md) uses existing APIs for
onboarding. Full lifetime reconstruction is optional audit work and is not a
user-facing prerequisite.

The [executor migration assessment](docs/EXECUTOR_MIGRATION_ASSESSMENT.md) maps selected personal-strategy source to the approved public design, with provenance hashes, required redesign and independent release tests. It implements no public execution.

## Start locally

Use Node 24 LTS and Python 3.14. macOS and Linux are supported development targets; use WSL2 on Windows. Install PostgreSQL 16+ only for database-backed work. Docker is not required.

```sh
git clone https://github.com/domino-money/domino.git
cd domino
npm ci
npm --prefix web ci
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-api.lock
npm --prefix web run dev -- --host 127.0.0.1 --port 3000
```

Open http://127.0.0.1:3000. The practice UI and all automated tests need **no wallet, RPC key or funds**. Frontend contributors can omit the Python setup until needed.

```sh
npm run check:web
backend/.venv/bin/python -m unittest discover -s backend/tests -v
npm run test:contracts
npm run check:read-bridge
backend/.venv/bin/python scripts/export-read-contract.py --check
backend/.venv/bin/python scripts/export-read-openapi.py --check
backend/.venv/bin/python scripts/export-session-contract.py --check
backend/.venv/bin/python scripts/export-onboarding-contract.py --check
```

The default Python suite explicitly skips PostgreSQL and native EVM cases. To run the full suite:

```sh
npm --prefix app ci
node scripts/test-contracts.mjs --match-path test/setup/DominoSetup.t.sol
node scripts/test-contracts.mjs --match-path test/reference/OfficialDominoExecutionV4.t.sol
node scripts/test-contracts.mjs --match-path test/audit_engine/SwapReinvestment.t.sol
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -v
backend/.venv/bin/python backend/dev_postgres.py stop
```

The helper runs a private Unix-socket cluster, with disposable test databases separate from the development catalogue. `DOMINO_PG_BIN` selects an installation when discovery needs help. It never upgrades an existing database directory. Root `npm ci` installs the pinned Anvil, Forge and Solidity compiler used in tests.

Optional read-only provider setup and API commands are in [backend/README.md](backend/README.md). Keys are entered locally at a hidden prompt, never committed. The local Python API rejects browser origins and is **not** the deployed web API; use the shared fixtures until the candidate bridge completes staging and frontend integration.

## Work together

**Execution first, planning afterward:** all authorized collaborators and agents may work across every area, integrate and deploy within the requested scope, without area owners or repeated approvals. Direct pushes are allowed; PRs, reviews and issues are optional coordination tools. CI continues as feedback. Both `rugged97` and `OxDecimal` have administrator access. See the authoritative [execution policy](docs/EXECUTION_POLICY.md), [contribution guide](CONTRIBUTING.md) and [assistant instructions](AGENTS.md).

| Directory | Responsibility |
| --- | --- |
| `web/` | React / TypeScript / vinext practice UI and server preview endpoints |
| `backend/` | Python / FastAPI read API, PostgreSQL accounting, OpenAPI and fixtures |
| `api-contracts/read-v1/` | Shared read schemas, types, validators and fixtures |
| `api-contracts/session-v1/` | Separate wallet-login schemas, types, validators and fixtures |
| `bridge/` | Disabled Cloudflare read and session Worker candidates |
| `contracts/` | Public Domino V1 entrypoints, technical V4 bases, official-pool integration and adversarial regressions |
| `scripts/` | Pinned compiler wrapper and repository checks |
| `reports/` | Historical qualification evidence; not current production state |

The existing owner-only Sites preview is a separate deployment. GitHub membership does not grant Sites access. Preserve `web/.openai/hosting.json`; publish only through the approved Sites workflow from a **separate checkout rooted at `web/`**, so the Sites source remote never replaces this repository's GitHub remote. No automatic deployment workflow is included.

Third-party Uniswap reference sources retain their original notices and licenses in `backend/tests/reference/v4/`; see [third-party notices](backend/THIRD_PARTY_NOTICES.md).

The current public V1 candidate is described in the [independent audit specification](reports/V1_INDEPENDENT_AUDIT_SPEC_2026-09-21.md), including complete-suite reproduction and the distinction from the original frozen V4 baseline.
