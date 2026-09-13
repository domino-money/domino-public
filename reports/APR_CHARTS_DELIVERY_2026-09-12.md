# APR and chart consumer delivery

Owner priority: integrate #127/#128 and activate the #13/#92 consumer. Work
performed on 12 September 2026 in Brasília (13 September UTC for the runtime
update), under [EXECUTION_POLICY.md](../docs/EXECUTION_POLICY.md).

## Integrated behavior

- Read-v2 `2.0.0-rc.1` supplies one pool-market observation and a separately
  attributed estimated pool fee APR. Read-v1 remains `1.1.0-rc.3`, with its
  qualified historical APR meaning unchanged.
- The table, ticker and figures dialog consume that estimate without another
  market fetch. Values retain exact decimal strings, source, original times,
  zero/missing distinctions, stale state and five-minute expiry. A disabled or
  unavailable V2 capabilities response falls back to V1 before any V2 data
  POST. A V2 data failure never triggers a second market read through V1.
- Hourly charts load on demand in the figures dialog. The selected token's
  address and provider orientation are checked together. Candles retain
  original OHLC values, timestamps, gaps and open/closed intervals. Rejected
  duplicate candles remain unavailable, without removing usable market data.
- Development V2 uses the same identity, admission and shared budgets as V1.
  The local client retains the 10.1-second pacing added in `5c0f034`.

## Runtime and public activation

The immutable backend release
[`85e7511`](https://github.com/domino-money/domino/tree/85e751109765822349cd9b65313602e8513aa89d)
is installed in both production and development. Production uses reader 8876
and gateway 8878; development uses 8890/8891. Both gateways enable only
`pool-market` in V2 and retain all seven V1 reads. Both tunnels reconnected
Healthy with four connections after the rolling update. Credentials,
provider/network configuration, admission, expiry, quotas and PostgreSQL were
preserved; no SQL migration was applied. Financial services remain inactive.

Public V2 activation still requires the Cloudflare change described in the
[#13 delivery notice](https://github.com/domino-money/domino/issues/13#issuecomment-5649546868).
The existing Actions token can access Pages, but Worker settings returned
403/code10000 and Tunnel configuration returned 401/code1001 in the
[actual inspection](https://github.com/domino-money/domino/actions/runs/34726730503).
The owner explicitly directed this Cloudflare work to @OxDecimal. This is a
missing provider credential scope, not a review or acknowledgement gate.

The manually dispatched `Publish read path` workflow supports `inspect`,
`app`, `bridge` and `publish`, on an exact main commit. App publication uses
the existing recorded build, preview upload and production upload of the same
digest. Bridge publication adds only the specified V2 tunnel paths and
deploys the existing read Worker with V2 `pool-market`, retaining its current
V1 flags and Access secrets. Use bridge publication after the VM update; a
successful app upload alone does not prove the public V2 path is live.

## Verification

Backend integration passed 207 affected Python tests, 734 JavaScript tests,
six bridge configuration tests, generated-artifact checks and repository
hygiene. Eleven publication/path-preservation tests passed. Browser smoke
against the built app, real beta middleware and read Worker with package
fixtures displayed the estimate in table/ticker/details and loaded both
selected chart currencies. Observed requests were one V2 market POST plus
two token reads initially, one activity read on opening details, and one
chart read for each explicit load/currency selection. No live-provider
financial qualification or authenticated public V2 success is claimed by
that fixture smoke.

The earlier #132 Windows/HMR/hot-admission acceptance waiver remains in force.
No cancelled denial test was performed. Other report priorities, private
performance and financial execution are outside this delivery.
