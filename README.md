# Domino

Private source repository for a wallet-friendly Uniswap v4 liquidity app on Robinhood Chain. The approved alpha includes self-compounding and Domino successor positions. The product UI is English, playful and modern with restrained retro details.

## Current status

- **Web:** approved Tangerine practice workbench, position/activity cards, modal workflows and hypothetical fee calculations. Browser-local practice data; no live deposits or signing.
- **Backend 0.7.0:** generic token reads, verified pool identities, a reorg-aware PostgreSQL public catalogue, fee/position accounting, historical capital, price observations and snapshot NFT ownership lookup.
- **Valuation gate:** missing or unqualified prices keep USD TVL/APR unavailable. Alchemy's tested Prices API does not support Robinhood address queries. Pool coverage is partial; source coverage and freshness must stay visible.
- **Contracts:** fee arithmetic and policy-validation libraries, a draft interface and synthetic boundary tests. Public vault execution, swaps, wallet authentication and tenant isolation are not production implementations.

The personal live bot, operator wallet, credentials and operational database are outside this repository. See [implementation status](IMPLEMENTATION_STATUS.md), [alpha scope](ALPHA_SCOPE.md) and [security specification](SECURITY_SPEC.md).

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
```

The default Python suite explicitly skips PostgreSQL and native EVM cases. To run the full suite:

```sh
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -v
backend/.venv/bin/python backend/dev_postgres.py stop
```

The helper runs a private Unix-socket cluster, with disposable test databases separate from the development catalogue. `DOMINO_PG_BIN` selects an installation when discovery needs help. It never upgrades an existing database directory. Root `npm ci` installs the pinned Anvil, Forge and Solidity compiler used in tests.

Optional read-only provider setup and API commands are in [backend/README.md](backend/README.md). Keys are entered locally at a hidden prompt, never committed. The local Python API rejects browser origins and is **not** the deployed web API; use fixtures until a reviewed integration bridge exists.

## Work together

Both `rugged97` and `OxDecimal` have **administrator access to the entire repository**. Frontend/backend ownership is coordination, not an access restriction. See [contribution workflow](CONTRIBUTING.md), [assistant instructions](AGENTS.md) and [frontend handoff](FRONTEND_HANDOFF.md). Work is tracked in [GitHub Issues](https://github.com/domino-money/domino/issues).

| Directory | Responsibility |
| --- | --- |
| `web/` | React / TypeScript / vinext practice UI and server preview endpoints |
| `backend/` | Python / FastAPI read API, PostgreSQL accounting, OpenAPI and fixtures |
| `contracts/` | Solidity draft interfaces and arithmetic tests |
| `scripts/` | Pinned compiler wrapper and repository checks |
| `reports/` | Historical qualification evidence; not current production state |

The existing owner-only Sites preview is a separate deployment. GitHub membership does not grant Sites access. Preserve `web/.openai/hosting.json`; publish only through the approved Sites workflow from a **separate checkout rooted at `web/`**, so the Sites source remote never replaces this repository's GitHub remote. No automatic deployment workflow is included.

Third-party Uniswap reference sources retain their original notices and licenses in `backend/tests/reference/v4/`; see [third-party notices](backend/THIRD_PARTY_NOTICES.md).
