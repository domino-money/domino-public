# Where the per-hop records go, and how long they stay

`docs/API_READ_BRIDGE.md` asks for one record per request — id, route,
contract version, duration, status, safe reason, cache and limiter outcome —
and for application diagnostics to be kept seven days initially, aggregate
counts up to thirty. The records exist since 012ee83 and a5e85a8: every hop
emits exactly one JSON line, with a fixed key allowlist and bounded values,
and never a body, address, cookie, signature or assertion. This is the
measured answer to the question those commits left open: where each line
lands, and for how long. Measured on 2026-09-18 on the home VM; nothing here
is asserted from memory.

## The VM services

The reader, the gateway, their development twins and the five private
listeners write the line to stderr. systemd-journald stores it; the host also
has `ForwardToSyslog=yes`, so rsyslog keeps a second copy in `/var/log/syslog`.
Both copies are the same bytes, so the redaction the emitter enforces holds in
both.

| Store | Retention as configured | Measured |
|---|---|---|
| journald (`/var/log/journal`) | nothing set; `journald.conf(5)` defaults apply: `SystemMaxUse` 10 % of the file system capped at 4 GB, `MaxRetentionSec` 0 (time-based deletion off) | 117.3 MB in use; oldest retained `domino-read` and `domino-gateway` lines 2026-09-11 (8 days); the development reader wrote 29 lines in 24 h |
| rsyslog (`/var/log/syslog`) | `logrotate`: weekly, `rotate 4`, compressed | current file 15.5 MB; the second copy lives about five weeks |

So on the VM a record is kept at least the seven days the specification
asks for, and in practice far longer: the journal is bounded by size, not
time, and syslog by five weekly rotations. If seven days is to be a bound as
well as a floor, that is two operator changes, not made here:

```sh
# journald: a time bound beside the size bound.
sudo install -d -m 755 /etc/systemd/journald.conf.d
printf '[Journal]\nMaxRetentionSec=7day\n' | sudo tee /etc/systemd/journald.conf.d/50-domino-retention.conf
sudo systemctl restart systemd-journald
# rsyslog: the copy in /var/log/syslog follows /etc/logrotate.d/rsyslog;
# `daily` with `rotate 7` bounds it the same way, for every syslog line.
```

Reading them:

```sh
# Every hop record of the read path in the last hour, one line each.
sudo journalctl -u domino-gateway -u domino-read --since '-1 h' --no-pager -o cat | grep '^{'
# One request across its hops: the gateway's id is carried into the reader.
sudo journalctl -u domino-gateway -u domino-read --since '-1 h' --no-pager -o cat | grep '"requestId":"<id>"'
# The snapshot refresher's own ticks (27a1d73).
sudo journalctl -u domino-read --since '-1 h' --no-pager -o cat | grep '"mode":"refresh"'
```

Two things the VM side does not record: a request the development boundary
refuses before the reader's middleware sees it (the development gateway
records its side; the reader's silence is a gap in that lane's observability
only), and any request while the deployed release is `85e7511`, which
predates the records — production's journal held 0 JSON lines in the 24 h
before this was written, and will hold them from the read-path switch on.

## The Worker

`bridge/src/worker.mjs` writes its line with `console.log` in the fetch
wrapper, with the same allowlist, and `bridge/test/worker.test.mjs` pins that
nothing else is in it. **Today that line is not kept anywhere.** The file the
release publishes, `bridge/wrangler.read.toml`, says `logpush = false` and
`[observability] enabled = false`, and the repository's own guard
(`scripts/staging/check_bridge_configs.py`, with
`test_refuses_alternate_ingress_and_logging`) pins both for every Worker and
refuses `tail_consumers`. That policy was written when the Workers were
disabled review candidates that provisioned nothing; it is still what
`scripts/publish-read-path.mjs` deploys, with `--keep-vars` carrying only the
variables from the live Worker. The only way to see the line is a live
`wrangler tail`, which retains nothing — and which needs Worker read access
the release token does not have yet (`docs/CLOUDFLARE_RELEASE_TOKEN.md`).

What Cloudflare offers, from its documentation on 2026-09-18:

| Path | What it keeps | Retention | Plan |
|---|---|---|---|
| Workers Logs | `console.log` lines and, unless disabled, one invocation log per request with `<Method> <URL>` and request metadata | 3 days on Workers Free, 7 days on Workers Paid; 7 is the maximum | included in both; Paid includes 20 million events a month |
| Workers Logpush | Workers Trace Events to a destination such as R2 | the destination's | Workers Paid, plus an account role with Logpush access or a token with Logs Edit |
| OpenTelemetry export | traces and logs to an OTLP destination, `persist: false` possible | the destination's | — |

The specification's seven days is met by Workers Logs on the Paid plan and
not on Free; which plan the account is on is a question for the account
holder. For anything past seven days, or the thirty-day aggregates, Logpush
or OpenTelemetry export are the next step, later.

The configuration that keeps the hop line and nothing more:

```toml
[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
invocation_logs = false
```

`invocation_logs = false` matters: the invocation record carries the raw
method and URL and request metadata, which is exactly what the hop line
exists not to record. With it off, the custom line is the record on the
Worker as it is on the VM. The alpha's volume is far below the included
events, so sampling stays at 1.

This is a change to the guard and its test before it is a change to the
file: the repository refuses logging by design today, and turning it on for
the read Worker (and, family by family, the others) is a decision to record
in `check_bridge_configs.py` and `test_bridge_configs.py`, not to slip past
them. It is not made here.

## Not configured anywhere

The specification also asks for alerts on contract mismatches, service-auth
failures, deadline overruns, exhausted provider budget and sustained read
failures, and for contract and build ids in deployment audit records. No
alerting exists on either side; the records now carry the reasons an alert
would key on (`upstream_contract_mismatch`, `read_deadline_exceeded`,
`provider_capacity_busy`, `read_capacity_busy`), which is the prerequisite,
not the alert.
