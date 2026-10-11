# Multichain funding and position corrections

## Confirmed causes

- The existing Cloudflare read-v6 bridge already enabled portfolio, activity, chain pools, balances and tokens. Production Pages had the nine expected service bindings. No new tunnel, VM access, RPC configuration or bridge deployment is required for the app fixes below.
- The automation picker and links restricted positions to Robinhood/v4 despite the deployed V2 contracts supporting qualified Base and Arbitrum positions. Base runtime code matched the deployment manifest; registry admission and halt checks do not by themselves prove an executor daemon is operating.
- Transfer progress was repeated across nested cards and arrival was disconnected from the next usable funding action. A delivered amount and the wallet's current spendable balance are different facts: the supplied Base transactions delivered USDC and ETH, then spent the USDC in a separate transaction before creating the position.
- A successful creation could be absent from the indexed portfolio for a while. Receipt confirmation, index discovery and current portfolio balances must be represented separately.
- Creation receipts lacked the reviewed pool's token metadata, so the BASECAT amount could appear as raw units and an address.
- The supplied console errors point to injected `pageProvider.js`/`contentscript.js` code. The application CSP is retained; no inline-script/style exception was added to suppress extension errors.

## App changes

- A compact transfer card presents progress, confirmed arrival and an explicit action to use currently available funds. It supports reduced motion and keeps routing details secondary. It does not send, switch networks, spend delivered tokens or request a new quote automatically.
- Compound and Domino setup retain chain, DEX/manager and NFT identity across links, picker, review and consent. A selection change invalidates the prior review. Actual capability, halt and operator checks remain authoritative.
- Receipt-backed discovery hints show a newly created position while the shared portfolio catches up, without inventing balances or eligibility. The existing reviewed receipt reader continues after internal navigation for Base and Arbitrum, with bounded polling, visibility/network pauses and identity checks. Explicit reorganization evidence invalidates the corresponding confirmation and discovery hint. Verified atomic-batch receipts retain their transaction hash for the same reconciliation.
- Review receipts use the token metadata frozen with the reviewed pool. Base and Arbitrum use the existing position chart controls to show real, timestamped current fee and price observations recorded during this browser session.

## Remaining data limitation

Read-v6 currently returns portfolio/activity and current snapshots. Robinhood's current Fees/Your APR path is the Pages Functions `/api/fees/v1/state` and `/api/fees/v2/ledger`, reading Rugged's Robinhood RPC; it is not `performance-v2`. That older service is intentionally disabled. Pool price history uses the Robinhood-specific read-v3 contract. Neither an existing generic history route nor a multichain lifetime-fee/APR response was found in the inspected code or Cloudflare routes. The new session observations are **not** lifetime earnings, complete historical coverage or APR. Missing history remains explicitly unavailable. Personal APR does not require USD pricing: it requires verified earned fees and time-weighted liquidity exposure, valued in the quote token.

The BASECAT position is visible through the public portfolio on the live preview with current token balances and fee balances. USD estimates are qualified independently; an on-chain check of this pool's executable USDC depth was below the existing minimum. The app retains token amounts when the producer does not qualify a USD value. No pricing threshold was weakened.

Completing historical/APR parity requires a supported multichain history/accounting producer response and its deployment. The owner explicitly prohibited changes to Rugged's VM; this release does not access or change it.

Confirmation after a full reload, or for a position created before this change, still depends on the indexed read-v6 finality evidence: no reviewed receipt client can be recovered from those old sessions. The navigation fix does not repair an old producer response marked `unfinalized`, including the reported Base position. Its creation was independently confirmed on-chain; correcting that indexed state requires the producer to reconcile it.

## Evidence and verification

- Base creation transaction `0x41cbad956ac906b5685e6207cabdf3234ef07002e2bbaf8958ba4e1a8e190a26` succeeded at block 52469635 and was finalized when checked.
- Cloudflare inspection workflow: [38150045036](https://github.com/domino-money/domino/actions/runs/38150045036). Inspection only; no infrastructure mutation.
- Local unit and browser regressions cover transfer recovery/arrival, Base and Arbitrum v3/v4 setup, identity collisions, consent reset, delayed indexing, token decimals, session chart observations and Robinhood's existing position/history behavior. Browser tests use local wallets and services; no real financial transaction was submitted.
- Publication uses the existing app-only release workflow: the same recorded build goes to preview and production, retaining service bindings and security configuration. Final check and deployment results belong to the associated PR/release run.
