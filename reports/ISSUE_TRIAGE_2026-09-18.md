# Open issues against `main` — 18 September 2026

Every open issue (21) was read in full, including comments, and each of its
acceptance criteria or task items was checked against `main` at 874bf31
(HEAD eb945a8 during the run) — the code that implements it, the tests that
pin it, the reports and runbooks that record it, and the dated records on
#177 and #138. Each recommendation to close was then given to three
independent reviewers instructed to refute it, with "keep open" as the
default when uncertain; each recommendation to keep open was checked by one
reviewer for at least one genuinely undelivered item. 46 reviewers in all,
no failures. Nothing was closed, labelled or commented by this analysis.

## What should be closed now

**Nothing.** Two issues were proposed for closure as superseded and both
proposals were refuted three times over:

- **#14** (Connect a wallet and a SIWE session). All six acceptance criteria
  are on `main` with tests (PR #111, 25bf8f8, 2026-09-12) and CI runs them.
  But the issue's own goal — an owner proves control of an address in the
  deployed app — cannot complete: `bridge/wrangler.session.toml` still says
  `SESSION_BRIDGE_ENABLED = "false"` and never said otherwise
  (`git log -S` finds no flip), the session listener is installed but off,
  and the issue's 2026-09-11 queue note keeps "real HTTPS, Worker, listener
  and human-wallet acceptance" as its own remaining gates. Those gates are
  #170's activation work. Keep #14 open until #170 activates the family, or
  fold it into #170 explicitly and close it then; either way its label
  `status:ready` misdirects and should read blocked-by #170.
- **#138** (the 13 September audit). Every P0 line is delivered in code,
  tests and reports — with today's corrections (the wallet-assets batching
  only executes since 0ff76b6, the discovery batching since 328992a/d52c5ad,
  the snapshot's persistence and background refresh since 27a1d73). But its
  ticked T2.1 line reads "one GET for all listed pools, refreshed by a
  background job, cacheable at the edge (ETag / Cache-Control)", and on
  `main` the route is POST-only and every hop answers `no-store`
  (`backend/read_api.py`, both gateways, `bridge/src/worker.mjs`). The edge
  caching was left out of 27a1d73 on purpose because it changes three hops
  and their contracts; the checkbox as written is therefore not met. #138 is
  an umbrella whose §4 checklist lives in #158–#175, so it stays open while
  any of them does; the owner may re-scope the T2.1 edge-caching sentence
  into its own issue and tick the line — a decision, not a closure.

## What stays open, and why

Per issue: what is delivered on `main`, what remains, the strongest
undelivered item (the one a second reviewer confirmed), and the owner
decision the issue waits on. Evidence for every cell is in the run's
journal; the columns are counts of items, not of importance.

| Issue | Title | Delivered | Remaining | Strongest remaining item | Pending decision |
|---|---|---:|---:|---|---|
| #14 | Connect a wallet and a SIWE session in the app | 7 | 2 | Activation of the session family so a real sign-in completes on domino.money (VM listener --enable and egress, Worker SESSION_BRIDGE_ENABLED=true with | Owner to confirm that the human-wallet HTTPS acceptance (docs/WALLET_SESSIONS.md gates 1 and 4) is owned by #170 (T5.1) and that OxDecimal's |
| #138 | Backend: serve every figure fast from Domino's own RPC/Alc | 17 | 12 | Activation on production of everything since 85e7511 (T1.x/T2.x are on main, not live) — tracked in #177 §2 | Owner: strict independent-source USD rule vs labelled reference path (#162; PRODUCTION_QUALIFICATIONS empty); Owner: which RPC plan provides |
| #158 | T3.1: Pool ingestor on-chain (Swap + ModifyLiquidity + Don | 5 | 5 | WSS newHeads subscription plus PoolManager log subscription filtered by the selected PoolIds (the core of #158), with its gap-fill and removed-log han | Owner (OxDecimal): does the polling follower from T1.6/T1.7 (#153 closed; domino-queue-worker.timer every 60 s, --lag 100, read treats cover |
| #159 | T3.2: Infra do ingestor: wss provider, websockets dep, ser | 0 | 4 | Adicionar campo `wss://` + validador no provider config (hoje HTTPS-only) — item 1 de #159; é o mais forte porque é pré-requisito dos outros três e a  | None recorded in #159 itself. A practical dependency: #165 (T3.8) still has to measure the Alchemy plan's WebSocket subscription limits, and |
| #160 | T3.3: Ledgers continuos activity->fees->positions->capital | 3 | 3 | Continuous serialized ledger follower activity->fees->positions->capital per chunk (the core deliverable of #160) is not started on main and is not tr | Owner: which RPC plan/provider supplies historical state for the ledger backfill (issue body 'Decisao'); evidence points at the configured A |
| #161 | T3.4: Candles on-chain hourly/daily a partir dos swaps arm | 1 | 5 | Build and serve on-chain hourly/daily candles from the stored swaps (issue #161 / #138 §4 P1 T3.4): no candle builder exists on main, and the only pri | Not stated in #161 itself, but governing its shape: whether candles may be served pool-ratio quoted before #162 (T3.5) resolves the strict-v |
| #162 | T3.5: Precos USD (#4): collector + migration 006 + registr | 8 | 5 | The labelled consumption path shipped in ec5f8ec ("Consume the mapped reference series in the metrics valuation") cannot deliver a served figure on ma | Owner: keep the strict rule (independent sources, <=300 s, PRODUCTION_QUALIFICATIONS) or admit the labelled reference lane for display — iss |
| #163 | T3.6: Habilitar pool-metrics em prod gateway, dev reader/g | 2 | 3 | Enable pool-metrics in the development reader and development gateway (and, with it, the production gateway's DOMINO_BRIDGE_READS / Worker ENABLED_REA | Whether to enable pool-metrics on the production gateway and Worker before it 'can be current' (#160/#162 open): OxDecimal's #177 §2.3 lists |
| #164 | T3.7: Aposentar price path de enderecos Robinhood no manag | 0 | 1 | Retire the Robinhood-address price path of `manage_metrics --fetch-prices` (the issue's only task; #138 §4 "P1: Alchemy" line 217 is still `- [ ]`). T |  |
| #165 | T3.8: Qualificacao live Alchemy: multi-page inventory, spa | 3 | 6 | Live qualification of the Alchemy inventory (#165 task line 1 = #138 §4 "P1: Alchemy", body line 215, still "- [ ]"): a live multi-page `alchemy_getTo | Owner's #177 §4 question on whether Alchemy's ERC-20 coverage on chain 4663 is complete and whether the reader should add a known-token fall |
| #166 | T4.1: Price USD por token, 24h change, TVL/volume history  | 0 | 5 | 24h price change (not started anywhere; equally untouched: APR history). All four items of #166 plus the contract-version decision remain undelivered  | Owner (#162): keep the strict USD rule (independent sources, <=300 s) or allow the labelled `reference_analytics_only` path for displayed fi |
| #167 | T4.2: Servir pool transactions (swaps, adds, removes) com  | 1 | 4 | Serve pool transactions as a per-event list (swaps, adds, removes) with time and per-transaction amounts. No read route serves individual domino_activ | Owner (OxDecimal) on #162/T3.5: keep the strict USD rule (independent sources, <=300 s) or allow a labelled reference path — determines whet |
| #168 | T4.3: Positions by owner + valor e fees nao coletados em U | 0 | 3 | Positions by owner wallet (PositionManager has no owner enumeration -> needs a Transfer indexer or the Alchemy NFT API). Not started on main, not trac | Owner decision on #162 (strict independent-source rule vs labelled reference USD path) gates any USD figure on nft-positions; per #162 comme |
| #169 | T4.4: Protocol totals, token metadata, wallet balances com | 0 | 5 | Push or polling channel for price/TVL (SSE or short-poll ETag) — the owner deferred it in writing on 2026-09-18, every hop still answers Cache-Control | Owner (OxDecimal): whether the markets list stays at six pools or opens dynamically; widening past twelve cold pools per minute needs provid |
| #170 | T5.1: session-v1 (8879): env, --enable, egress, checks HTT | 2 | 4 | Environment file for the session family (/etc/domino/financial/auth/environment: DOMINO_SESSION_ORIGIN, _ABUSE_SECRET, _ACCESS_ISSUER/_AUDIENCE/_SERVI | Owner (OxDecimal): flip the Worker flag SESSION_BRIDGE_ENABLED on domino-session-bridge only after the VM listener is active and the HTTPS g |
| #171 | T5.2: onboarding-v1 (8880): env, --enable, egress | 4 | 4 | Egress for onboarding (rpc, Uniswap APIs, JWKS) is not applied on the host, and the renderer on main cannot even express it: its `uniswap` class pins  | Owner/operator must supply the pins for `trade-api.gateway.uniswap.org` and the Access issuer, and the private RPC config / Uniswap API key  |
| #172 | T5.3: deposit-v1 (8881): admission de producao, unknown-ha | 3 | 4 | Production admission file for deposit-v1 (8881): no `direct_existing_pool_v2` manifest for WETH/USDG has ever been produced or installed, and the only | Upgradeable token policy (owner): admit WETH/USDG in production under `direct_existing_pool_v2` with the 2026-09-10 reviewed profiles, or ke |
| #173 | T5.4: performance-v2 (8900): profiles listener/collector,  | 11 | 8 | Profiles for the performance-v2 listener and collector on the VM, i.e. activation of the 8900 family (private environment + profile under /etc/domino/ | Enrollment flow (#177 §2.5): keep operator-listed (owner, vault) subjects in the profile, i.e. an operator step per new sequence, or add a s |
| #174 | T5.5: execution-v1 (8901): intent producer, scheduler, sig | 3 | 5 | A production intent producer for execution-v1: no non-test code creates execution intents, so nothing exists for the signer to step, the scheduler to  | Key custody: reconcile docs/HOME_VM_RUNBOOK.md:113 (no signer key on this VM) with the installed domino-execution-signer unit that reads key |
| #175 | T5.6: Setup/Sequence V4: prepare -> 8 txs -> verify -> per | 4 | 5 | 8 transactions signed and submitted by the deployer on Robinhood Chain mainnet (chain 4663) — the Setup/Sequence V4 deployment itself. It is undeliver | deployer wallet (and its real native-token funding on chain 4663, docs/FINANCIAL_RELEASE.md:5-7); feeRecipient; operator (EOA, must not be a |
| #177 | Frontend of the #138 plan is published (39c59c2): backend  | 16 | 13 | §3.5 of #177: the honest Retry-After that 5cc5865 built never reaches the public read path — both gateways still stamp a constant '2' on every 429 (ga | Owner: create/scope the Cloudflare release token (Workers Scripts R+E, Cloudflare Tunnel R+E at account level) per docs/CLOUDFLARE_RELEASE_T |

Read across lanes:

- **T3 ingestor and ledgers (#158, #159, #160, #161)** — not started beyond
  what the polling follower already gives (#153, closed). #160 waits on
  which RPC plan supplies historical state for the backfill.
- **USD prices (#162, and #166–#169 behind it)** — the collector and its
  timer exist as a repository candidate (99d4491), migration 021 is
  registered, #4's criteria are transcribed there; the strict-versus-
  labelled-reference decision is still the owner's, the reference series
  cannot be served (the pool-metrics contract rejects it), and the timer is
  not installed. Every T4 item that needs a USD figure is gated on that
  decision.
- **pool-metrics (#163)** — gated by the owner's own precondition ("once it
  can be current": #160 and #162); the dev reader/gateway and the production
  gateway's read list are not enabled.
- **#164, #165** — one and two concrete items respectively, not started
  (retire the Robinhood-address price path; live multi-page and spam
  qualification of the Alchemy inventory, plus the plan's WebSocket limits).
- **T5 families (#170–#175)** — the shared substrate landed today (the
  continuous egress renderer, 89c44c8, applied ef8af15), and each family's
  own activation remains: private environment and profiles, Access app,
  tunnel route, Worker token and flag; #172's WETH/USDG review expires
  2026-10-10; #175 is the eight mainnet transactions and their deployer,
  fee recipient and operator.
- **#177** — the tracker: production activation (behind the release token),
  the Worker's v2 tolerance (§2.1), the gateway read list (§2.2), served age
  on `fromSnapshot` (§3.7), the dev lane's partial-page bound (§3.12), and
  seven owner decisions in §4, none recorded.

## Found on the way, in today's own work

Two defects the reviewers found in commits of 2026-09-18, not tracked
anywhere, to be fixed next:

1. **The rendered activation commands cannot start the listeners.**
   `scripts/staging/continuous_egress_policy.py` appends a bare `--enable`
   for `auth`, `onboarding` and `deposit`, but `backend/session_api.py:276`
   exits when `--rpc-config` is absent and `backend/onboarding_api.py:56`
   raises `session_rpc_config_required`; the private RPC configuration file
   must be named on the command. And the `uniswap` host class is
   incomplete: onboarding also posts to `liquidity.api.uniswap.org`
   (`backend/uniswap_position.py:21`), which the renderer would refuse to
   pin.
2. **The honest `Retry-After` never reaches the public path.** 5cc5865 made
   the reader's gate report the real wait, but both gateways rebuild
   headers with a constant `'2'` on every 429
   (`backend/read_gateway.py:178`, `backend/dev_read_gateway.py:205`) and
   discard the reader's header on a relayed 429. The visitor still backs
   off by a hopeful number.

## Labels

None of the eighteen sub-tasks carries a label, so nothing misdirects
triage by label — but nothing signals dependency either. Marking #163 and
#166–#169 as blocked on #162, #14 as blocked on #170, and #172–#175 as
waiting on their named decisions would let a reader see the graph without
opening each issue. That is the owner's call.

## Owner decisions, consolidated

#160 (RPC plan for backfill) · #162 (strict USD rule or labelled reference)
· #163 (enable pool-metrics before it can be current) · #169 (six pools or
an open markets list) · #170 (flip the session flag after the HTTPS gates)
· #172 (upgradeable token policy) · #173 (enrollment: operator-listed or
self-service) · #174 (key custody on the VM; operator funding) · #175
(deployer, fee recipient, operator) · #177 §4 (seven product decisions)
· #138 T2.1 (re-scope the edge-caching sentence or leave the line unticked).
