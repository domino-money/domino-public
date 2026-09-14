# Per-endpoint RPC batching qualification — T0.4 (#142, #147)

14 September 2026. Read-only batch check required by
[docs/READ_RPC_BATCHING.md:118-124](../docs/READ_RPC_BATCHING.md) before
rollout: the exact two- and five-item batches, on every configured primary
and fallback endpoint, under the existing reader identity and network policy.

## What ran

The check used the repository's own `ReadRpc.batch` at the deployed dev-reader
release `85e7511` (`/opt/domino/dev/releases/85e751109765822349cd9b65313602e8513aa89d`),
so the repo's validation rules applied unchanged: allowlisted read methods
only, explicit pinned block tags, 8-item/65,536-byte envelope bounds, exact
ID bijection, no partial results on failure.

Two phases per endpoint, matching the documented qualification path:

1. Pin the latest header sequentially (as the reader does).
2. Re-run the header read inside batches of 2 and 5 items pinned to that
   block, together with `eth_chainId` and bounded `eth_getCode` probes.

Source hashes of the code that ran:

| File | SHA-256 |
| --- | --- |
| `backend/discovery.py` | `3136e4b14f76ea3e876362ee45c76c4ec530468bb85cdb799df948e318aa6e1a` |
| `backend/rpc_config.py` | `92c09b1aebe54641d60e75ad4b85c82527472776a29fbcf177da2f48ae0374a4` |
| check script | `8433d83271e8d29fc38da214f65b33b811d965b9101c8bf995891ebc5cc0edb2` |

## Result

Configured endpoints (dev reader profile): one primary,
`robinhood-mainnet.g.alchemy.com` (no fallbacks configured). Every configured
endpoint was checked; there are no others.

| Probe | Items | Result | Duration | Notes |
| --- | ---: | --- | ---: | --- |
| Pin latest header (sequential) | 1 | success | 0.538 s | block 63074899 |
| Batch | 2 | success | 0.504 s | header re-read at pinned block + chain id; exact bijection |
| Batch | 5 | success | 0.839 s | header, 2 codes at pinned block, 2 chain ids; exact bijection |

Method/count/duration/success facts recorded above; no credentials, no
private URLs. The dev reader and dev gateway services were active before and
after the check with an unchanged main PID (`domino-dev-read` active since
2026-09-13 00:01:42 UTC, PID 43450); `domino-auth` is inactive by design at
this stage. Service state was not modified: the check is a read-only probe
executed beside the reader, not against its runtime.

An earlier negative calibration confirmed the check is not vacuously green:
batches using `latest` inside state-method params are rejected by the repo's
own `invalid_rpc_batch` validation, and were re-run correctly pinned.

## Scope and limits

- Robinhood public RPC (`rpc.mainnet.chain.robinhood.com`) is a configured
  default host but is **not** configured in the dev reader profile; it was
  not exercised. It must be qualified separately before any rollout that
  enables it as primary or fallback.
- Production reader/gateway runtime on the VM was not traced; this
  qualification covers the endpoint and envelope semantics under the reader
  identity, not a production deploy.
- No capacity limit, cache TTL, provider quota, refresh schedule or financial
  capability changed. The batch check gates only the documented rollout step;
  enabling batched reads in production remains a separate, reviewed switch.
