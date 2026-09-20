# Development Tunnel prevention — 20 September 2026

Deployed to `domino-alpha` under the owner's request to implement the preventive
plan. The infrastructure controller is separate from the application release;
reader/gateway source, financial capabilities and public contracts were unchanged.
See [operation and recovery](../docs/DEV_READ_RELIABILITY.md).

## Installed behavior

- Revocable standing authorization maintains synchronized finite seven-day
  firewall/reader/gateway grants. Reconciliation runs every 15 minutes, renewing
  when three days remain. It checks the adopted files/units, clock, DNS and TLS.
- Changed DNS pins are updated transactionally within the existing roles,
  hostnames and ports. Cloudflare Tunnel inventory remains separately constrained.
- The enabled continuous target validates authorization before starting dev,
  recreates volatile markers and recovers interrupted transactions.
- Reader, gateway and connector use restart-on-failure with ten-second backoff.
- The monitor runs about every minute, compares five deadline observations,
  recognizes planned cooldown and checks functional reads at most every 15 minutes.
- A task heartbeat named **Saúde do túnel dev-read** checks server health and
  observer freshness every 30 minutes, notifying on actionable transitions only.
  Server-side maintenance runs independently of the desktop. Desktop alert
  delivery requires its automation host to be available.

The successful live renewal issued deadline **27 September 2026, 12:28:36 UTC /
09:28:36 America/Sao_Paulo**. Under the active standing authorization this is a
renewable lease, not a planned service shutdown. The next ordinary renewal is
due around 24 September at the same UTC time, within the 15-minute check interval.

## Evidence

| Verification | Actual result |
| --- | --- |
| Focused offline tests | 38 passed: 25 maintenance and 13 health |
| Python syntax and whitespace | Passed |
| Native systemd unit verification | Passed for the installed package |
| Live deliberate renewal | Passed; three grants and committed lease agree; reader, gateway, four connections and real WETH read validated |
| Cold start of dev only | Passed in approximately 65 seconds; both `/run` markers recreated; production unchanged |
| Connector process killed deliberately | Automatic recovery in **14.3 seconds**; four connections and functional read restored |
| Blast-radius check for connector failure | Reader and gateway PIDs unchanged; production policy and PIDs unchanged |
| Missing browser/Access authority | Existing denial boundaries retained |

The cold-start exercise stopped only the development target, egress and bootstrap
services and removed their volatile markers. It did **not** reboot the VM or
interrupt production. Native validation evidence remains root-only under
`/var/lib/domino-dev-maintenance/`.

The first packaging attempt included macOS metadata as unit files. Native
verification rejected it before activation; installation was corrected to select
only explicitly named Domino unit files and transport without that metadata.
The first live renewal also exposed a gateway startup dependency: it requires
admission enabled before startup. That sequence was corrected, the old target
retired to remove cascading restarts, and a regression added before repeating
the successful renewal and recovery tests. The healthy prior lease was restored
during correction; production remained healthy.

## Explicit remaining limits

The public authenticated check is implemented but **not qualified live** because
no development Access client credential was available on the computer or the
scoped server locations. Current health reports this as its known warning, not
as an authenticated success. Supplying the private credential enables the check
on the next monitor invocation; it does not require disabling Access.

No independent always-on replica host was provisioned. A replica on the same
physical host would not address host failure. Guarded DNS refresh was selected
as the implemented alternative to moving RPC onto a private inter-host route.
Neither changing the public RPC tunnel nor exposing the node was required.

No unrelated frontend, EVM, accounting, PostgreSQL or production deployment
suite was rerun: this change adds isolated host-operation scripts and units.
