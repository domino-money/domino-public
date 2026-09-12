# Domino — technical implementation baseline

9 September 2026. UI direction accepted: Tangerine, position cards, step dialogs and a single-column Activity feed. This document records the architecture and local implementation; cloud infrastructure and a public financial launch remain separate delivery gates.

## Current evidence

The private practice app uses React 19, TypeScript, Vinext/Vite, Tailwind and existing Base UI/shadcn components on the Sites Cloudflare runtime. Its only financial endpoint is a hypothetical USD cost preview. Practice positions and receipts live in browser storage. Python supplies a reference calculation and benchmark. PostgreSQL has an applied local public-catalogue migration and a separate candidate private-account schema; Solidity has an interface draft and a no-swap fee-split library.

Wallet authentication, a production database deployment, live multi-user indexing, public vault implementation, fee-balancing swaps and remote execution are still missing. The live personal bot is a separate system and is not the public application's backend.

The first read-only discovery slice is now implemented in Python, separate from the personal bot. A bounded live probe verified the full identities of 17 MARLIN v4 candidates and read balances for native ETH, MARLIN and USDG by explicit address. Wallet-wide enumeration returned HTTP 403; provider volume/liquidity remain unreconciled, and APR/recommendations are unavailable. This is a CLI qualification step, not a connected account API or indexer. See the [measured qualification report](reports/DISCOVERY_QUALIFICATION.md).

The subsequent [local HTTP read service](reports/READ_API_QUALIFICATION.md) now uses FastAPI and optional Alchemy inventory, with a separate backend environment and private local provider configuration. Live checks returned 12 ERC-20 candidates, verified 13 currency balances including ETH and reverified 17 pools. Paginated cursors, failure states and address fallback are implemented; authentication, persistent accounts, typed frontend response contracts and UI integration are not. This resolves the sampled wallet's explorer-access obstacle without claiming complete chain inventory or production readiness.

API 0.2.0 also provides independent token-address lookup, incomplete-metadata states and exact PoolId fallback. The runtime accepts arbitrary Robinhood currency addresses without a MARLIN or stablecoin list. Read candidates are not certified token implementations or automation admissions. [Generic qualification](reports/GENERIC_TOKEN_QUALIFICATION.md) extends the evidence beyond the initial MARLIN sample and documents an asymmetric provider catalogue result for WETH/USDG.

API 0.3.0 now integrates a PostgreSQL catalogue using Psycopg 3 and a standalone SQL migration. Its bounded Initialize indexer has atomic checkpoints and confirmed-reorg rollback; lookup maps both currencies and supports pair filtering and revision-bound pages. The [measured catalogue](reports/CATALOGUE_QUALIFICATION.md) contains 217 pool identities across 135 currency addresses, with only a 6,000-block continuous indexed window plus revalidated observation seeds. WETH/USDG lookup works automatically from either currency. This local public-market database does not implement the proposed SQLAlchemy/Alembic private account layer, complete history, continuous worker operation or production hosting.

API 0.4.0 introduced an independent per-pool activity stream, rolling event quantities and active-liquidity reconciliation, [qualified on two pools](reports/ACTIVITY_QUALIFICATION.md). API 0.5.0 adds a separate versioned ledger for core LP/protocol trading fees with exact fee-growth reconciliation for hookless fixed-fee pools. [Fee qualification](reports/FEE_ACCOUNTING_QUALIFICATION.md) records 139 passing tests, including 37 PostgreSQL tests and differential checks against the original Uniswap math and Pool implementation. Collectible position earnings, attributed TVL, qualified USD prices and full-day APR remain incomplete; [methodology](METRICS_METHODOLOGY.md) distinguishes trading-fee allocation from those remaining claims. Authentication, public UI integration and financial execution remain separate milestones.

API 0.6.0 extends the fee ledger with versioned core-position state, principal and fee settlement, tick reconciliation and pool-attributed token flows. A bounded position endpoint exposes individual core records without treating the PoolManager caller as an NFT owner. [Position qualification](reports/POSITION_ACCOUNTING_QUALIFICATION.md) records 161 passing tests and seven reconciled real checkpoints. The remaining analytics gate is event-time asset/price history, qualified USD valuation and full-day time weighting. Production scaling, NFT/wallet ownership, authentication and financial execution remain unimplemented.

API 0.7.0 adds persisted capital after every event, exact time-weighted integration, external price ingestion and the conditional TVL/volume/fee-APR engine. Official PositionManager NFT reads now bind token ID, full pool identity, range, core position, liquidity and actual owner at one block. [Capital and NFT qualification](reports/CAPITAL_PRICES_NFT_QUALIFICATION.md) records the current evidence and price-provider gap. RPC and inventory work on Robinhood, but the Alchemy historical-prices endpoint rejects that network for address queries; native ETH observations alone cannot value the sample pools. Price-source qualification, complete live daily windows, wallet-NFT enumeration, authenticated accounts and execution remain delivery gates.

The owner's available NAS, Linux/GPU server and two GX10s are documented in the [home infrastructure study](HOME_INFRASTRUCTURE_STUDY.md). The proposed hybrid split uses home resources for development, historical data and batch work while retaining cloud services for public operations. No home deployment or change to the hosting baseline has been performed.

## Stack and responsibility

| Layer | Proposed baseline | Responsibility |
|---|---|---|
| Web | Preserve React, TypeScript, Tailwind and existing UI primitives | Guided creation, position cards, readable receipts and owner transaction review |
| Wallet integration | Wagmi, Viem and TanStack Query | Wallet connection, chain/account changes, user-signed calls and client request state |
| Application identity | SIWE challenges and server sessions | Prove wallet control; bind nonce, origin, chain and expiry; authorize private account records |
| API | Python + FastAPI, with typed schemas | Sessions, wallet inventory, pool discovery/metrics, funding quotes, onboarding progress, settings, positions and activity |
| Data | PostgreSQL; SQLAlchemy/Alembic for application models and migrations | Durable settings, observations, exact token accounting, execution intents and reconciliation |
| Indexing and planning | Python processes, deployed separately from the public API | Pool catalogue, rolling metrics, shared observations, reorg-aware indexing, explainable pool suggestions and strategy evaluation |
| Durable work | PostgreSQL jobs/outbox initially | Recoverable work, deduplication and serialized operator nonces; add a broker only for measured need |
| Contracts | Solidity + Foundry | Isolated owner/sequence vaults, bounded fee-only actions, fee accounting and direct owner exits |
| Operator signatures | Dedicated private service + AWS KMS secp256k1 | Independently reconstruct/check permitted transactions; sign with a bounded gas-funded operator key |
| Backend hosting | Docker containers on AWS ECS/Fargate; RDS PostgreSQL and KMS | Separate API, worker and signer roles, managed database operations and restricted signing access |
| Chain access | Alchemy primary and an independent provider such as QuickNode | Archive-capable reads, indexing/recovery and provider failover on Robinhood mainnet |

These are implementation choices, not claims that integrations have passed testing. Select and pin compatible package versions during implementation. Deployments and provider plans need actual capability and cost validation.

The existing web build remains in Sites for development and review. The earlier Vercel suggestion is not an implemented hosting decision: the current build is Vinext/Cloudflare. Preserve the UI and API boundary now; validate the public frontend runtime, custom domain, authentication and delivery checks before selecting its production deployment. Do not start a framework migration merely to match a hosting suggestion.

The product frontend in `app/` is hosted on Cloudflare Pages at `https://domino.money`: the static Vite build plus two Pages Functions. The middleware gates every request behind a shared password during the closed beta, and a fixed `/api` forwarder hands each API family to its bridge Worker through a private service binding (bound in production only, every Worker disabled); see `app/README.md` and `FRONTEND_HANDOFF.md`. This settles the static frontend's hosting only. The read bridge, session Workers and backend keep their own reviewed deployment and activation gates. A release is built once and its digest recorded (`npm run release:build` in `app/`); that same dist is deployed to the gated preview first and then promoted unchanged to production, never rebuilt in between. There is no sample or practice mode in the deployed frontend.

## System boundaries

The browser requests data from the API and asks the owner's wallet to sign setup, changes and exit. Connecting or signing in grants no financial approval.

Indexers persist coherent observations. Planners compare direct reinvestment, bounded swaps and waiting, then persist a proposal. An independent policy service checks the proposal before the restricted signer signs. Broadcasting and receipt reconciliation update durable state. The public API has no KMS signing permission.

On-chain ownership, permissions and receipts determine actual financial state; PostgreSQL indexes and reconciles them. USD values are derived displays. Financial authorization uses integer token base units, recorded decimals, exact tick conventions and versioned owner limits. A stale browser value cannot become a spending limit.

Each owner/sequence has isolated fee accounting and explicit authority. Unused fees remain available without being charged again. The approved 2% service cut funds ongoing gas; the receipt must not show that gas as a second owner deduction. Operator and owner economic checks remain separate. These rules are detailed in REINVESTMENT_POLICY.md and SECURITY_SPEC.md.

A retry does not reset valid observation history or create a second independent transaction. Jobs need idempotent state changes, global per-operator nonce coordination and reconciliation of ambiguous sends. A recovered database lease is not proof that a transaction was never broadcast.

## Wallet-first onboarding modules

[ONBOARDING_AND_POOL_DISCOVERY.md](ONBOARDING_AND_POOL_DISCOVERY.md) replaces the small starter-list entry assumption. Users can discover their Robinhood tokens, select a pair/LP fee/range, compare pool metrics, balance their chosen deposit and create a position. Advanced creation of a missing compatible pool is also approved alpha scope. Token discovery does not imply support for every hook or token behavior.

Keep inventory, pool catalogue, rolling analytics, suggestion policy, exact funding quotes and onboarding reconciliation as logical modules in the same stack. A provider's token/pair API can seed discovery; verify currencies, pool identity, balances and transaction state on-chain. Qualify Robinhood coverage, history and quotas before selecting enhanced data endpoints. Run a controlled indexer/subgraph if external coverage is inadequate. Generic v4 examples do not establish Robinhood support.

Persist currency identities, pool keys, versioned capability checks, block-bound metric snapshots, suggestion inputs/reasons, owner-bound deposit budgets and expiring quotes. The existing candidate schema does not yet contain these additions. Shared public market observations remain separate from private wallet budgets and onboarding state.

The funding planner calculates actual range-dependent token quantities with exact units and evaluates bounded owner-approved swaps; no default 50/50 assumption. Initial deposit budgets are separate from proven earned-fee balances. ETH handling includes native value, supported wrapping/refunds and wallet gas headroom. New-pool setup binds the chosen initial price and effective ticks and atomically initializes/adds first liquidity under owner limits; an optional preceding balancing swap remains a separate recoverable owner action.

Pool suggestions use versioned activity/depth/freshness filters before ranking. Thresholds need empirical Robinhood calibration. Do not use a suggestion score or pool APR as an oracle, signing permission or promised position return.

Funding quotes also bind the assisted-swap fee schedule/version, consumed-input base, exact fee, fixed recipient and net DEX input under [PRICING_POLICY.md](PRICING_POLICY.md). Keep this owner-funded service separate from the 2% earned-fee automation path and persist actual fee receipts for resumed onboarding. Rate selection and collection are new implementation work.

## Next internal milestone: wallet-connected read-only integration

The next internal milestone is a durable account and real position view using the approved UI. The requested invited-user alpha includes both Auto-compound and Domino; this read-only milestone does not constitute that alpha. [ALPHA_SCOPE.md](ALPHA_SCOPE.md) defines market compatibility, retained strategy behavior and release criteria. Sequence-aware data/API design and fork-based Domino development begin in this phase.

1. Implement and test migrations for accounts, wallets, one-use sign-in challenges, sessions, watched positions, observations and indexed events. The current positions schema assumes a vault-backed sequence; read-only imports need an explicit watchlist/ownership model without inventing a vault address. Keep practice data separate.
2. Add SIWE sign-in, session revocation and server-derived owner context. Verify replay, origin/chain mismatch, expiry, account switching and cross-account access. Support contract wallets only after their signature validation path is implemented and tested.
3. Implement Robinhood wallet inventory, native balances and token-address fallback; discover v4 pools and qualify trailing-24h volume, pool-attributed TVL and LP fee data. Verify actual owner, token identities, pool settings, ranges and liquidity. Index by block hash/log identity and handle transfers and reorgs. Share pool reads across users and retain coverage/provenance.
4. Connect real positions to cards and indexed receipts to Activity. Show block/time freshness and distinct stale, unavailable and out-of-range states. Display token amounts when USD valuation cannot be established; avoid invented zero values or extrapolated APR.
5. Add release identity/freshness handling and verify the delivered frontend references the intended asset version. An already-open page may be stale; offer a safe update without discarding an in-progress wallet review or onboarding step.

Indicative internal API surface: POST /auth/challenge, POST /auth/verify, POST /auth/logout, GET /me, GET /wallet/assets, GET /pools?token=..., GET /pools/{poolId}/metrics, GET /markets, GET /positions and GET /activity. Subsequent execution work adds owner-bound POST /onboarding/quotes and resumable onboarding intents; generating a quote cannot authorize a trade. The authenticated API derives the owner identity from the session; it does not accept a caller-supplied tenant as authorization. Exact payloads and pagination are implementation deliverables.

Acceptance: a wallet can authenticate, find its tokens and inspect matching pools and verified positions; incomplete inventory offers address search; metric coverage/freshness is explicit; data survives restarts; private records are isolated; unavailable reads do not fabricate values or erase valid history; duplicate logs and reorgs reconcile; practice records never become real holdings. This milestone has no automation-signing permission or public deposit endpoint.

## Subsequent gates

Implement resumable owner-signed creation/import, initial balancing swaps and advanced pool initialization, the generic public vault, both compound paths, Domino successor creation/funding, bounded fee-balancing swaps and restricted signing/broadcast recovery for the first invited functional alpha. Compound and Domino are user-selectable strategies on admitted markets. Swaps require token-conservation and price-integrity evidence; automated fee swaps also require the ongoing owner-benefit gate. The alpha exit gate includes operational wallet-funded creation and Domino, independently reviewed execution scope and owner recovery; the read-only milestone remains an internal dependency. Re-estimate the schedule for this expanded critical path.

## Primary references checked

- [Wagmi integration](https://wagmi.sh/react/getting-started): React wallet tooling, Viem and TanStack Query integration.
- [SIWE, EIP-4361](https://eips.ethereum.org/EIPS/eip-4361): wallet authentication message and verification requirements.
- [FastAPI containers](https://fastapi.tiangolo.com/deployment/docker/): container deployment model.
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): database isolation requires correctly scoped roles and policies; it does not replace application authentication.
- [RDS PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html): managed PostgreSQL option.
- [Robinhood connectivity](https://docs.robinhood.com/chain/connecting/): mainnet 4663, commercial providers, archive reads and public-RPC limitations.
- [AWS KMS key specifications](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html) and [Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html): secp256k1 and digest signing. KMS is a signing primitive; transaction-policy enforcement and Ethereum encoding/recovery need a separately tested implementation.
