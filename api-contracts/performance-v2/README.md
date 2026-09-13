# Private managed performance V2

Version `2.0.0-rc.1`. All routes are authenticated POSTs below
`/api/performance/v2/` (`/internal/performance/v2/` at the loopback gateway),
using `X-Domino-Performance-Contract`. The BFF forwards only the opaque session
cookie and CSRF header; the service derives the owner and reauthorizes delivery.

`enroll` accepts an admitted vault and its complete active NFT set, scheduling a
forward canonical opening. Existing fees are opening capital. `epochs` lists the
session owner's enrolled subjects; optional `after` paginates eight at a time.
`cards` returns up to eight enrolled epoch snapshots and exact decimal strings.
It never acquires blockchain or provider price data. Public ownership is not
wallet authentication. These operations grant no spending or signing authority.

The collector runs only for enrolled subjects whose visible lease was refreshed
in the last 90 seconds. Refresh a visible batch every 30–60 seconds; pause hidden
tabs and clear all owner data when the session changes. The durable queue and raw
and financial cursors survive restarts. RPC work has a global rolling budget,
one process, two bounded collection steps per tick and 60-second restart cooldown.
One additional bounded step materializes a closed minute without provider calls.
Delivery reads at most1442 exact minute summaries and two raw edge minutes;
changed price qualifications invalidate saved values and schedule recomputation.

USD metrics come only from persisted reconciled financial evidence and admitted
event-time price series. Missing prices, incomplete income/capital, reorgs and
staleness retain explicit states. APR requires a complete valued rolling day.
`projectedApyPercent` remains null. Gas is not subtracted twice from service fees;
full L2 operator cost remains unavailable until qualified independently.

Fixtures are synthetic calculator/ledger evidence, not proof of live prices,
production history or 24-hour capacity. V1 remains required-null and unchanged.
