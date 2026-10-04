# Node proxy stall — 3 October 2026

> Public copy: the private network address has been redacted to
> `192.0.2.1`, an RFC 5737 documentation address. Ports, timings and
> measurements are preserved; this address is not a live endpoint.
> Matching JSONL rows carry `endpointRedacted: true`.

After the #315 deploy, the node proxy on `domino-prod-02` (`127.0.0.1:18547`,
HAProxy) added about 45 ms to most calls, so the reader went back to
rpc.domino.money first. This is the read-only investigation of that stall and its
fix. The fix was applied on 4 Oct 2026 with the owner's go (see Outcome); the
investigation itself changed nothing.

## Finding

The stall is on clawber, between `systemd-socket-proxyd` and the node. HAProxy
does not cause it. A request that reaches clawber in more than one TCP segment is
answered about 40 ms late:

- socket-proxyd forwards each piece as it arrives. Its connection to the node,
  `127.0.0.1:8547`, keeps Nagle's algorithm on: the program makes no `setsockopt`
  call at all (systemd v252, v255, v257 and main);
- Nagle holds the second piece until the node acknowledges the first;
- the node's kernel delays that acknowledgement by its 40 ms minimum. The node
  has nothing to send until the request is complete, so no reply carries the
  acknowledgement sooner.

A request reaches clawber in pieces in two cases:

- **It is larger than 1,228 bytes.** That is the TCP segment size (MSS) over the
  tailnet's 1,280-byte MTU (`ss`: `mss:1228 pmtu:1280`). The reader's eight-call
  token batch, about 1.3 KB, always arrives in two segments.
- **Its client writes the headers and the body separately, and HAProxy reads
  them separately.** `http.client` writes them separately, and so do urllib and
  the backend's loopback opener. HAProxy 2.8 sends every request's headers at
  once (`http_process_req_common` sets `SC_FL_SND_ASAP`), then the body when it
  arrives.

The response direction is not affected. The socket's `NoDelay=yes` covers the
connection socket-proxyd accepts, and a 47.8 KB answer returns in 4 ms.

## Evidence

[probe.py](node-proxy-stall-2026-10-03/probe.py) ran on the VM on 4 Oct 2026,
00:16–00:18 UTC. Each case is 60 sequential calls on one kept connection, 20 ms
apart (40 for `code`), with read-only methods. Each cell shows how many calls
took over 25 ms, with the median in ms. The raw lines are in
[results.jsonl](node-proxy-stall-2026-10-03/results.jsonl).

The three endpoints:

- **HAProxy:** `127.0.0.1:18547`, the path services use.
- **Direct:** clawber's socket `192.0.2.1:18549`, bypassing HAProxy.
- **Tunnel:** the reverse SSH tunnel, `127.0.0.1:18548`.

The request sizes include headers:

- **tiny:** `eth_blockNumber`, 151 bytes.
- **batch8:** eight `eth_call`s, 1,187 bytes, which is one segment.
- **batch10:** ten `eth_call`s, 1,461 bytes, which is two segments.
- **code:** `eth_getCode` of the v4 PositionManager, 201 bytes, answered with 47.8 KB.

The writes:

- **one:** headers and body in one write.
- **two:** headers and body back to back.
- **http.client:** the library's own two writes.
- **two-gap:** the body 2 ms after the headers.

| Request | Write | HAProxy | Direct | Tunnel |
| --- | --- | --- | --- | --- |
| tiny | one | 0/60 (3.5) | 0/60 (3.4) | 0/60 (3.3) |
| tiny | two | 5/60 (3.5) | 41/60 (43.5) | 1/60 (3.3) |
| tiny | http.client | 0/60 (3.8) | 45/60 (43.8) | 0/60 (3.6) |
| tiny | two-gap | 60/60 (43.9) | 60/60 (44.1) | 60/60 (46.7) |
| batch8 | one | 0/60 (4.6) | 0/60 (4.7) | 0/60 (4.7) |
| batch8 | two | 7/60 (4.8) | 43/60 (44.9) | 0/60 (4.7) |
| batch8 | http.client | 6/60 (5.1) | 51/60 (44.9) | 1/60 (5.0) |
| batch8 | two-gap | 60/60 (45.1) | 60/60 (45.1) | 59/60 (48.4) |
| batch10 | one | 41/60 (44.9) | 44/60 (45.0) | 0/60 (5.2) |
| batch10 | two | 45/60 (45.3) | 48/60 (45.3) | 0/60 (5.1) |
| batch10 | http.client | 38/60 (45.2) | 49/60 (45.3) | 0/60 (5.2) |
| batch10 | two-gap | 60/60 (45.6) | 60/60 (45.7) | 0/60 (10.1) |
| code | one | 0/40 (4.3) | 0/40 (4.1) | — |
| code | two-gap | 40/40 (45.0) | 40/40 (44.9) | — |

- **Without HAProxy, the stall is the same.** Every request that left the VM as
  one segment was answered at a 3–5 ms median, none over 25 ms. Every request
  sent in two pieces 2 ms apart took about 44 ms, at every size.
- **Through HAProxy, `http.client`'s two writes stall less often than when sent
  direct.** HAProxy usually reads both and forwards them as one segment. A
  1,461-byte request is split by the tailnet whatever the client does.
- **The tunnel does not split by size.** OpenSSH carries each write as one
  packet, and its client on clawber writes it to the node in one piece. Separate
  writes stall there too. The tunnel is the backup, so nothing is proposed for it.
- **The packet timings place the wait inside clawber.**
  [capture.txt](node-proxy-stall-2026-10-03/capture.txt) is a header-only capture
  on the VM's `tailscale0`. For a split request, clawber acknowledged both
  segments one round trip later (3 ms), and its answer followed 38.5 ms after
  that.
- **HAProxy's statistics show the same cost.** `show stat` gives `direct` an
  average response time of 15 ms over its last 1,024 requests. An unsplit call
  takes about 4 ms.

## Not fixable in HAProxy

- **`option http-no-delay` would change nothing.** It only stops HAProxy from
  holding data back with `MSG_MORE`, and HAProxy already sends request data at
  once (see above). A held send would also wait about 200 ms, not 40.
- **TCP_NODELAY is already set.** HAProxy sets it on both of its connections
  (`session_accept_fd`, `tcp_connect_server`), and the capture shows the VM sending each
  segment at once.
- **`option http-buffer-request` would only fix small requests.** HAProxy would
  send each request in one write, so requests of at most 1,228 bytes would stop
  stalling (the `one` rows). Larger requests would still arrive in two segments
  (`batch10 one`), so the reader could not move. It is not proposed.

## Proposal: clawber (owner)

Run socat instead of `systemd-socket-proxyd`. socat sets TCP_NODELAY on its
connection to the node (`nodelay`). The socket unit does not change: same
listener, allow-list, `FreeBind` and `NoDelay`. Only the service's command
changes, as one drop-in:

```ini
# /etc/systemd/system/domino-rpc-direct.service.d/50-nodelay.conf
[Service]
ExecStart=
ExecStart=/usr/bin/socat ACCEPT-FD:3,fork,max-children=256 TCP4:127.0.0.1:8547,nodelay
```

- **`ACCEPT-FD:3`** accepts on the listening socket systemd passes, as
  socket-proxyd did.
- **`fork`** serves each connection in a child process.
- **`max-children=256`** keeps today's limit of 256 connections.
- **`ACCEPT-FD` needs socat 1.8.0.0 or later** (Ubuntu 24.04, Debian 13; `socat -V`).
  An older socat needs the inetd form instead:
  - the socket gets `Accept=yes` and `MaxConnections=256`;
  - a template unit, `domino-rpc-direct@.service`, runs
    `socat STDIO TCP4:127.0.0.1:8547,nodelay` with `StandardInput=socket`;
  - it keeps the same `DynamicUser` and allow-list, with
    `User=domino-rpc-direct` so that all instances share one user.
- **Unchanged:** the node, its port, the sequencer feed, the tunnel and the VM.

Check on clawber first, on loopback only, with this report's `probe.py`. The
live path is not touched:

```sh
systemd-socket-activate -l 127.0.0.1:18551 /usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:8547 & a=$!
systemd-socket-activate -l 127.0.0.1:18552 /usr/bin/socat ACCEPT-FD:3,fork,max-children=256 TCP4:127.0.0.1:8547,nodelay & b=$!
python3 probe.py 127.0.0.1:18551 127.0.0.1:18552 --patterns one,two-gap --calls 20
kill $a $b
```

Expected: on `18551` every `two-gap` call takes about 40 ms; on `18552` it takes
about 2 ms, which is the gap. The second line is the drop-in's command, so a
socat that refuses an option fails here, not in production.

## Deploy plan

The VM needs no change and no HAProxy reload.

1. **clawber (owner):** install socat if needed, then run the loopback check.
   Then:

   ```sh
   sudo install -D -m 0644 50-nodelay.conf /etc/systemd/system/domino-rpc-direct.service.d/50-nodelay.conf
   sudo systemctl daemon-reload
   sudo systemctl restart domino-rpc-direct.service
   ```

   **Impact.** The socket keeps listening, and new connections wait in its
   backlog. HAProxy's open connections to `direct` close:
   - A call in flight at that moment fails, and its caller falls back to its
     next route as on any proxy error.
   - HAProxy's `observe layer4 … on-error mark-down` may take `direct` down for
     about 4 s, until two checks pass. The tunnel serves in the meantime.

   The automation and the writer read through this proxy, so pick a quiet
   minute.

   **Rollback:** remove the drop-in, run `daemon-reload` and restart the
   service. The effect is the same short failover.

2. **Verify from the VM (read-only):**

   Set `DIRECT_RPC_ENDPOINT` privately to the approved direct `host:port`.

   ```sh
   python3 probe.py 127.0.0.1:18547 "${DIRECT_RPC_ENDPOINT:?set approved host:port}" --http-client
   ```

   Expected:
   - **Every row:** a median of 3–6 ms, and no call over 25 ms. That includes
     `batch10`; the `two-gap` rows add only the 2 ms gap.
   - **HAProxy:** in `show stat`, `direct`'s response time falls from about 15 ms
     toward 4 ms.

3. **Reader to the proxy (needs the owner's go):**

   ```sh
   R=b806a3666f98cf47ee034501dbe43d06bd38fce4
   READ_PROVIDERS=/opt/domino/releases/4c3ee322308900303c679088bc4712ef16500763/read/backend/runtime/providers.json
   (cd / && sudo -u domino-read /opt/domino/releases/$R/read/backend/.venv/bin/python3.14 -B \
     /opt/domino/releases/$R/read/backend/configure_rpc.py --node-loopback on --config-file $READ_PROVIDERS)
   sudo systemctl restart domino-continuous-reads.target   # the target only, never its members
   ```

   `configure_rpc.py` checks the proxy first (chain, managers, shared block) and
   saves only if the check passes.

   **Verify.** `lead` in `/root/deploy-315/common.sh` prints `proxy`; it never
   prints a URL. Then:
   - the read chain's `private node RPC` counter grows
     (`nft list chain inet domino_continuous_reads read`);
   - token reads (the `curl` in `/root/deploy-315/drill.sh`) come in under the
     90–100 ms of rpc.domino.money;
   - the reader's journal has no `rpc_failover` and no `read_deadline_exceeded`.

   **Rollback:** the same command with `--node-loopback off`, then one restart
   of the target.

After the clawber change, `docs/FRESH_HOST_INSTALL.md` describes the new service
line (this PR).

## Outcome

Applied with the owner's go on 4 Oct 2026, 00:44–00:49 UTC. The record is
PR #318's comment of that time.

- **clawber:**
  - socat 1.8.0.0 is installed (the Ubuntu 24.04 package).
  - The loopback check matched the prediction. socket-proxyd's `two-gap` calls
    had a 41–42 ms median, with 20 of 20 over 25 ms. socat's had a 2.2–3.4 ms
    median, with none over 25 ms.
  - The drop-in went in, and `domino-rpc-direct.service` restarted at 00:46:40.
    HAProxy kept `direct` up; two answers in flight were reset (`eresp` 2).
- **The VM, probe at 00:52 UTC:** the HAProxy and direct cases above, in
  [results-after.jsonl](node-proxy-stall-2026-10-03/results-after.jsonl).
  - One call of 1,600 took over 25 ms: a single 92 ms outlier, not the 40 ms
    pattern.
  - `batch10`, the two-segment request, now has a 4.7–5.4 ms median. The
    `two-gap` rows take 5.3–6.7 ms, of which 2 ms is the gap itself.
  - `direct`'s average response time is 3 ms; it was 15.
- **The reader:**
  - It now leads with the proxy (`--node-loopback on`), after one target
    restart at 00:48:34.
  - Token reads take 21–39 ms. They took 90–100 ms on rpc.domino.money and
    154–233 ms on the stalled proxy.
  - No `rpc_failover` and no `read_deadline_exceeded` since the switch.
- **Unchanged:** the node, the sequencer feed, the tunnel and HAProxy.

## What the investigation ran

Everything ran on the VM; nobody logged in to clawber. The probe's direct calls
reached clawber's socket the way HAProxy's do.

- **`probe.py`**, unprivileged, with read-only methods: `eth_blockNumber`,
  `eth_call` to ArbSys and `eth_getCode`.
- **`tcpdump`**, headers only, limited to the probe's own connection, under sudo.
- **Read-only inspection under sudo:** `ss`, `nft list ruleset`, HAProxy's
  `show stat`, the installed `haproxy.cfg`, the #315 deploy scripts and the
  reader's unit.

No service, configuration, package or provider file changed. No URL with a token
was used or printed.

Sources read: systemd's `src/socket-proxy/socket-proxyd.c` (v252, v255, v257,
main), HAProxy 2.8's `session.c`, `proto_tcp.c`, `http_ana.c` and `stconn.c`, and
socat's manual and changelog.
