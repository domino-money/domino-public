# Domino practice workbench

English prototype for wallet-literate people learning concentrated liquidity, scoped to the Robinhood Chain product. The approved Tangerine direction uses orange accents, rounded position cards, quiet retro details, and light/dark appearances.

## Working flows

- Open on the position collection. Create a hypothetical MEME/USDG card in one dialog with Amount, Range, Explore and Review steps. Compare the changing asset mix with holding the initial assets.
- Open a card to inspect its totals, pause/resume practice or run a fee scenario through Inputs and Review. Back navigation preserves inputs; action footers stay outside the content overflow area for short screens and zoom.
- Review the starting deposit, price range, proposed 2% service fee and LP-specific tradeoffs.
- Retain existing browser-saved positions and receipts under the unchanged storage schema. Practice scenarios run manually, with no background automation.
- Submit fee scenarios to the server cost endpoint and record gross fees, service cut, net reinvestment, waiting fees and operator gas in Activity.
- Scan compact Activity cards: green signed additions, red signed service deductions, amber waiting balances and neutral zero values. Open a receipt with Amounts, Costs and Why this action tabs; exact precision is optional, sub-cent amounts remain visible, and gas is clearly included in the service fee.
- Use all balanced fees when the cost gate passes, without a fixed idle allocation; preserve temporarily uneconomic balances without charging twice.
- Explain waiting balances and retain historical receipts from the former 15% net-addition policy without rewriting them.
- Separate previously waiting fees from newly added fees in previews and receipts, and show the 2% charge basis. New fee inputs start at zero for a balance-only recheck. Older receipts derive the split only when their preceding balance is known; truncated history is labeled unavailable.

All positions and earnings are explicitly simulated. This application contains no wallet connection, transaction signing, actual pool pricing, customer funds or access to the personal bot. Local browser storage is a practice feature, not a multi-user financial database. The user-owned private Sites publication is for review; public financial launch gates remain in the product security specification.

## Development and checks

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 8877
npm run test
npm run typecheck
npm run lint
npm run build
```

The application tests cover range boundaries, exact fee conservation, full reinvestment above the former cap, cost thresholds, re-evaluation after lower gas, legacy receipt compatibility, malformed inputs, and isolation of practice positions. `lint` intentionally targets application, domain, script and test source; the supplied component catalog is vendored and unchanged.

`POST /api/v1/compound-preview` accepts exactly three decimal strings: `availableFeesUsd`, `positionValueUsd`, and `gasUsd`. It rejects oversized/invalid input and provides a non-executable USD scenario. `GET /api/v1/capabilities` makes disabled live capabilities explicit. No financial authorization should be inferred from the cost result.

The proposed 2% service cut includes execution gas. Policy version 2 uses a 15% gas buffer and all available eligible fees, with no percentage-of-position addition cap. The buffer is not money withheld from the owner. The scenario assumes balanced fees and constant price; it does not model token ratios, fresh observations, owner advantage, slippage, or a real execution path. Bounded fee-balancing swaps are a planned public-product requirement, explicitly labeled as not simulated. Existing local receipts preserve their historical policy and waiting balances can be rechecked by entering zero new fees.

## Dependency review

The starter's React/RSC, Vinext, Vite and Cloudflare toolchain were updated to compatible patched versions. The `sharp` override pins 0.35.4 to avoid the reported bundled-image-library vulnerability. Check `npm audit` when updating the lockfile; an audit database report is separate from independent contract/application review.

The future Python planner and PostgreSQL data model live in the parent product package and are not deployed inside this Cloudflare preview.
