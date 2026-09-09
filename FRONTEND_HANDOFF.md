# Frontend handoff

Audience: wallet users who trade tokens but are new to LPs. The app should make positions understandable without implying guaranteed profits or eliminating market risk. The UI language is English.

## Approved direction

Tangerine accents, modern rounded cards with light retro details. Positions are NFT-like cards; activity uses exactly one card per row at all widths. Highlight net reinvestment in green, costs in red, and use signed numbers plus labels so color is not the only cue. Keep exact receipts in a modal with progressive details. Creation and management unfold in dialogs/cards, without a long scrolling procedure.

The practice workbench is the visual baseline. Preserve its distinction between simulations and real transactions. Do not redesign the palette or introduce a fixed reserve of fees as part of integration work.

## First integration slices

1. A typed read-data adapter and deterministic mocks for token, pool, activity, capital and NFT owner views. Coordinate contract gaps against `backend/openapi-read.json`; amounts stay strings.
2. Read-only position cards using this adapter: token pair, range, snapshot, fees, principal and owner status. Hide unavailable valuation behind a clear state, never a plausible invented number.
3. Token and pool selection dialogs: wallet token or pasted address, explanation of pairing, existing pools, fee/range choices and metadata/freshness states. Advanced new-pool initialization is a separately labeled path and remains non-executable until implemented.
4. Loading, unavailable, stale and partial states with retry that preserves prior data. Responsive interaction and accessible keyboard/focus behavior.

Each slice has its own GitHub issue and acceptance criteria. Mock data must be unmistakable; a successful mock cannot enable deposit, swap, mint, compound or successor creation. Read integration must not remove the current browser-Origin restrictions on the Python service. A same-origin bridge is a separate task.

## Data rules

- Identify assets by chain and address; symbols/decimals are optional, untrusted metadata. A zero-decimal token is valid, missing decimals are different.
- Distinguish a measured zero from missing data, and partial discovery from an exhaustive empty result.
- Retain provenance, block/hash, coverage and freshness. Mixed wallet pages do not share a single snapshot.
- TVL, volume and APR require qualified historical inputs. Current Robinhood USD-price coverage is not qualified.
- NFT owner at a snapshot is public data, not wallet authentication or user authorization.
- Display service charges against consumed fees; never silently charge principal or unused fee balances.
