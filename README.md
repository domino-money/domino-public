# Domino

[![Public CI](https://github.com/domino-money/domino-public/actions/workflows/public-ci.yml/badge.svg)](https://github.com/domino-money/domino-public/actions/workflows/public-ci.yml)

**Concentrated liquidity management for Uniswap v3 and v4.**

Published for transparency, consultation and security review. See the
[source availability and review terms](LICENSE.md) for permissions and exceptions.

Domino brings pool discovery, position management and fee reinvestment into one
wallet-facing app. It combines a React frontend, Python data and automation
services, and Solidity contracts for owner-authorized liquidity operations.

The code supports two reinvestment modes: **Auto-compound** adds eligible earned
fees back to a position; **Domino-compound** can also create and fund successor
positions within the owner's policy. The repository includes position creation,
fee accounting, bounded swaps, auto-exit and owner recovery paths.

The app also includes cross-chain funding and a signed-in Points page with
Season 1 referral links. [Points](docs/points/POINTS.md) count eligible usage;
they are not money or tokens and carry no promise of future rewards.

[Run locally](#run-locally) · [Codebase](#codebase) · [Tests](#tests) · [Security and audit evidence](#security-and-audit-evidence)

## Status and network support

**Alpha software.** This repository contains the application and its supporting
services, contracts and tests. Live data and financial actions depend on configured
services, deployment manifests and the capabilities those services expose. Cloning
the repository does not provision an operator, connect production infrastructure
or activate transactions.

The committed Domino V2 profiles cover:

| Network | Chain ID | Uniswap versions |
| --- | ---: | --- |
| Robinhood Chain | 4663 | v3 and v4 |
| Base | 8453 | v3 and v4 |
| Arbitrum One | 42161 | v3 and v4 |
| Elysium | 99901 | v4 only |

These are code and profile capabilities, not a claim that every pool or operation
is available. This snapshot includes Elysium's enabled profile and the app's
pinned [deployment record from 9 November 2026](docs/deployments/v2-elysium-99901-2026-11-09/README.md).
Its native currency is HYPE, and its liquidity flows use Uniswap v4 only. See the
[chain profiles](api-contracts/v2/chains/) and [chain qualification procedure](docs/v2/QUALIFY_CHAIN.md).

Cross-chain funding follows each chain's provider and token allowlists. On
Elysium, S2 supports transfers to and from its USDC through **Relay only**;
Across and native HYPE transfers are not supported. See the
[bridge design](docs/v2/F5_BRIDGE.md) and [cross-chain API contract](api-contracts/crosschain-v1/README.md).

Domino V1 and V2 are application/contract release families; Uniswap v3 and v4
name the underlying AMM protocols. Both Domino generations remain in this
repository for compatibility and historical verification.

## Run locally

Use **Node.js 24** and npm, as pinned in [`.nvmrc`](.nvmrc). The full development
toolchain supports macOS, Linux and WSL2. Python and PostgreSQL are unnecessary
for this frontend walkthrough.

```sh
git clone https://github.com/domino-money/domino-public.git
cd domino-public
npm --prefix web ci
npm --prefix app ci
npm --prefix app run dev:fixtures -- --host 127.0.0.1
```

Open **[http://127.0.0.1:5273](http://127.0.0.1:5273)**.

The [limited review permission](LICENSE.md#limited-review-permission) covers
this local walkthrough. This read-only mode uses synthetic fixtures to explore
the interface and its data states without a wallet, RPC key or funds. It does not reproduce the full
V2 financial flows. The `web/` install is required because the app shares its
domain modules. See the [app guide](app/README.md) for normal application build
modes, browser checks and further development.

The separate `web/` practice workbench can also be explored locally:

```sh
npm --prefix web run dev -- --host 127.0.0.1 --port 3000
```

### Backend setup

Backend work uses **Python 3.14**, pinned in [`.python-version`](.python-version).
Install PostgreSQL 16+ only when running database-backed work; Docker is optional.

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-api.lock
```

The [backend guide](backend/README.md) covers local services, provider
configuration and disposable test databases. The browser reaches backend APIs
through the edge/bridge layer; the standalone local read API deliberately
rejects browser origins.

## Codebase

| Directory | Purpose |
| --- | --- |
| [`app/`](app/) | Product UI: React, TypeScript and Vite; wallet flows, pools, positions and activity |
| [`web/`](web/) | Practice workbench and shared domain calculations used by the app |
| [`backend/`](backend/) | Python/FastAPI services, PostgreSQL accounting, indexing, planning and automation |
| [`bridge/`](bridge/) | Cloudflare Workers for bounded read and authenticated API transport |
| [`contracts/`](contracts/) | Solidity contracts, pinned compiler tooling, unit, fuzz and integration tests |
| [`api-contracts/`](api-contracts/) | Versioned schemas, runtime validators, ABIs, chain profiles and shared fixtures |
| [`docs/`](docs/) · [`reports/`](reports/) | Design references, release records and dated verification evidence |

For the V2 design, start with the [contract interfaces](docs/v2/F0_INTERFACES.md),
[vault and custody model](docs/v2/F3_VAULT.md),
[automation backend](docs/v2/V2_AUTOMATION_BACKEND.md) and
[read API](docs/v2/V2_INDEXER_READ_API.md). The
[V1 contract guide](contracts/README.md) explains the earlier release family.

## Tests

Install the root tools once before running contract or combined checks:

```sh
npm ci
```

This installs the pinned Forge, Anvil and Solidity compiler. With the frontend
and Python dependencies above installed, choose the checks for the layer you
are changing:

| Check | Command |
| --- | --- |
| App logic | `npm --prefix app test` |
| App types and lint | `npm --prefix app run typecheck && npm --prefix app run lint` |
| Full app, including browser suites | `npm run check:app` |
| Practice workbench | `npm run check:web` |
| Backend | `backend/.venv/bin/python -m unittest discover -s backend/tests -v` |
| Solidity | `npm run test:contracts` |
| Bridge and shared API contracts | `npm run check:read-bridge` |
| Repository hygiene | `npm run check:repository` |

Browser suites require a Chromium-based browser; set `DOMINO_BROWSER_PATH` when
it is not discovered automatically. PostgreSQL and native EVM backend cases are
opt-in and skipped by the default Python command. Follow the
[backend setup](backend/README.md) and [V2 integration guide](docs/v2/INTEGRATION_TESTS.md)
for their prerequisites.

[Public CI](docs/PUBLIC_CI.md) runs a limited offline verification suite on
GitHub-hosted runners with read-only permissions and no operational credentials.
It does not replace the full application, browser, database or EVM suites above.

## Security and audit evidence

Keep keys, wallet material and operational configuration outside Git. Local
fixtures are test data. Missing, stale or unqualified financial data must remain
explicit; the interface must not invent balances, prices or returns.

- [Security model](SECURITY_SPEC.md) and [owner setup and recovery](docs/OWNER_SETUP_AND_RECOVERY.md).
- [V2 audit package](reports/V2_AUDIT_PACKAGE.md), [initial findings and remediation](reports/v2-audit-2026-10-04/README.md), and [reaudit evidence](reports/v2-audit-2026-10-04.2/README.md).
- [V2 freeze and reproducibility](docs/v2/FREEZE.md), including the scope of frozen artifacts.
- [Public sanitization provenance](docs/PUBLIC_SANITIZATION.md).

This is a sanitized publication of a private development repository. Public
`sanitized/` tags and audit ZIPs identify derivatives of the original evidence;
they do not preserve original Git signatures or constitute a new audit.
Historical reports describe their recorded revisions, not the current state of
a deployed service. Contributions should start from this public repository so
unsanitized private history is not reintroduced. See the
[contribution guide](CONTRIBUTING.md) for development conventions.

## License and third-party material

Domino is published for transparency and consultation under the
[source availability and review terms](LICENSE.md). Otherwise unlicensed
Domino material is available for local inspection, evaluation and testing;
general reuse, redistribution and production operation require separate permission.

**Existing licenses remain in force.** The Solidity files in `contracts/src/`
already carry MIT SPDX identifiers and retain those permissions. Third-party
code, data, fonts and artwork keep their own licenses. The review terms do not
revoke permissions granted for earlier versions or override applicable licenses.

See the [backend notices](backend/THIRD_PARTY_NOTICES.md),
[contract reference provenance](contracts/test/reference/README.md),
[font licenses](app/public/licenses/fonts/README.md) and
[wallet artwork notices](app/public/wallets/PROVENANCE.md).
