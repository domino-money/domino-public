# Production monitor

`backend/ops_monitor.py` watches what the V2 rollout runs on: the services, the chains and the operators' balances. Each minute it does three things:
- checks everything below;
- alerts on Telegram when a level changes;
- writes a public status snapshot for the operator's dashboard.

It reads only. It never signs, sends no transaction and serves nothing.

## What it checks

| Check | Source | Warning | Critical |
| --- | --- | --- | --- |
| Each service | `systemctl show` | `activating` | `failed`, from the first cycle that sees it; not loaded, `inactive` (stopped) |
| Each timer and its service | `systemctl show` | the service's last run failed | timer not active |
| V2 automation, per chain | its pass lines (journal) | 3 passes in a row with an error; a signer problem held for 3 passes | no pass for 4 cadences (at least 120 s); 10 errors in a row; signer refused (`balance_low`, `not_admitted`, `has_code`) |
| V2 automation's journal, per chain | `attention` and `gas` in its pass lines | gas spent in the last 24 hours at 80% of `gas.dailyCapWei`; passes that report neither | an intent in `attention` for 15 min; gas at the cap, or a send refused there (`v2_daily_gas_cap`) |
| V2 indexer, per chain | its round lines | | no round for 5 min |
| Top pools (featured) | domino-featured's tick lines | the day's list not published by 12:31 UTC | no line for 10 min; the list served 2 days or more after its publication; fewer than 3 pools |
| V1 automation | its cycle lines | no cycle for 15 min | |
| Listeners (read, gateway, auth, plan, crosschain, execution-status) | their request lines | 5 responses 5xx in an hour | 20 in an hour |
| Operators' balances | `eth_getBalance` at the head | below the warning floor | below the critical floor |
| The own node's lag | its loopback proxy, never a fallback | 3 min | 10 min, or no answer |
| Reads per chain | the services' endpoint files and sealed URLs | a chain's reads failed | |
| Disk | `/` | 85% | 95% |

**The launch alerts (2 Nov 2026):**
- **A service down.** The units in `services` are read with `systemctl show` every cycle. In production that list holds the eleven the launch names: auth, crosschain, position-plan, execution-status, read, gateway, tunnel, continuous-egress and the three V2 automation instances. It also holds featured, the public-data units and the V2 indexers.
  - `failed` means systemd gave up: the restarts or the start limit are spent. A restart it schedules shows as `activating (auto-restart)`. systemd 255 (the VM's) passes through `failed` on its way to a restart only within that one state change, which no reader sees (`service_enter_dead`). So `failed` alerts at the first cycle that sees it.
  - On 2 Nov, domino-execution-status hit its start limit and stayed failed for 80 s. The cycles saw it active, failed, then active, and under the 2-cycle rule nothing was sent.
  - `inactive` (stopped), `deactivating` or not loaded wait for a second cycle, because a deploy's own restart passes through them in about a second.
  - The monitor's sandbox already allows this read (`RestrictAddressFamilies` includes `AF_UNIX`). No unit changes.
- **Attention.** An intent in `attention` (`v2_executor.py`) means a nonce the chain spent without one of our receipts (`nonce_consumed_without_receipt`), or a receipt that is not ours (`receipt_identity_mismatch`).
  - It stops the chain's signer: no compound, no exit and no return is sent there until an operator runs `v2_automation.py acknowledge --intent <id>`.
  - Each pass reports the journal's intents in `attention`, with `since`, the time each entered it. The reconciliation that puts one there is an event at once. Once one has held the signer for 15 minutes it is critical, repeated every 3 hours, until a pass reports it gone.
- **Gas.** Each pass reports `gas.spentWei`, the rolling 24-hour spend the executor counts against its cap (what was paid, else what is reserved), and `gas.dailyCapWei`, the cap itself (0.0025 ETH per chain today).
  - The spend is a warning from 80% of the cap, and critical at 100%.
  - A claim reserves its gas before it is sent and is refused when it would pass the cap, so the spend stops short of 100%. A pass refused at the cap (`v2_daily_gas_cap`) counts as the cap reached too.
  - That refusal used to be an event on every pass with a candidate. It is now this one level.
- **Passes that do not report the journal.** A release of the automation before these fields, or a malformed report, is a warning, never read as the current state.
- **Top pools** (the Top pools review of 2 Nov 2026, item 1). The served list is carried and repaired without end, and its `generatedAt` moves with each repair, so the list's own dates do not show its age. The service (`manage_featured.py serve`) logs one line a tick, every 30 s while live: its phase and mode, the day's `selection`, `live.publication` and `live.health`. The monitor reads them like the automation's passes, with no database access.
  - **Silence:** no line for 10 min is critical. The longest silence from 20 Oct to 2 Nov was a selection's tick, 321 s. In `shadow`, idle ticks print nothing, so silence is normal there.
  - **Publication:** the day's list is published between 12:00 and 12:30 UTC, as a `served` publication. From 12:31 a day without one is a warning, with the selection's outcome, its eligible and evaluated counts, the publication's last status (`no_draft`, `carried_over`, `vetoed`, …) and the newcomers still not ready (`unready`). It holds overnight, until a list is published.
  - **Age:** the list's age counts from that publication, never from a carry or a repair. 2 days or more is critical.
  - **Size:** the list's size is the policy's `size` minus the vacancies `live.health` reports. Fewer than 3 pools is critical. The monitor reads `size` and `selectionHourUtc` from the `featured_policy.json` its own release carries.
  - These three apply while the phase is `live` and the mode `auto`; an owner's list (`manual`, `off`) is left alone.
  - **First start:** a monitor without the list's history finds the last publication once, with `journalctl --grep` over the unit's last 7 days. When nothing matches, that is critical too.
  - **Withdrawals:** each pool that leaves the list is an event, with its reason. The daily summary has a line for the list: when it was published, its pools and the withdrawals of the last 24 hours.

**Events** are sent as they happen, each once:
- a V2 execution submitted, confirmed or reverted (a send refused at the daily cap is the gas check's, never an event);
- an intent in `attention`;
- a pool withdrawn from the Top pools list, and why;
- new V2 vaults;
- an automatic restart;
- every log of the V2 registry, decoded with the exported ABI.

The registry's administrative events are critical: halt, operator, publisher, fee recipient, guardian, governance, router and scheduled changes.

A unit's first read (its last 15 minutes) is history: it is counted, never announced.

**Alert policy:**
- A level counts once it holds for 2 cycles, so a restart or one late pass alerts no one. A `failed` unit counts at once.
- A critical alert repeats every 3 hours while it lasts.
- A return to normal is announced once.

**Daily summary:** at 12:00 UTC, the last 24 hours:
- passes, errors, sends and confirmations per chain;
- each balance and what left it (decreases only, so a top-up does not hide spending);
- the listeners' requests by route and status;
- the registry's events and the new vaults;
- the Top pools list: when it was published, its pools, its withdrawals;
- the node's worst lag, the automatic restarts and the open alerts.

**Commands:** `/status`, `/resumo` and `/help`, answered only in the configured chat. Other chats are ignored.

## Telegram

1. The owner creates a bot with @BotFather and seals its token once:

   ```bash
   ssh -t domino-prod "sudo sh -c 'umask 077; systemd-ask-password -n \"Telegram bot token:\" | systemd-creds encrypt --with-key=host+tpm2 --name=telegram-bot-token - /etc/credstore.encrypted/telegram-bot-token'"
   ```

   The unit imports the token (`ImportCredential=telegram-bot-token`). It is never an environment variable or a file in clear.
   - Every request URL carries the token, so a failure becomes a fixed code (`telegram_http_401`, `telegram_unreachable`, …).
   - No URL and no transport exception ever reaches a log or a message.
2. The owner sends `/start` to the bot, or adds it to a group.
3. `ops_monitor.py --config … discover`, run with the unit's credentials, prints the chats that wrote to the bot: ids and names only. The chosen id goes into `telegram.chatId`.

With `chatId` null the monitor still checks and writes the snapshot, and Telegram stays off.

## Configuration

One private JSON file, `/etc/domino/monitor/config.json` (0600 in a 0700 directory, owned by `domino-monitor`), validated whole. Its keys:

- `telegram`: `{credential, chatId}`.
- `intervalSeconds` (60) and `summaryHourUtc` (12).
- `statusFile` and `stateFile`.
- `services`: the units checked.
- `timers`: `{timer: service}`.
- `automation`: `{chain: {unit, passSeconds}}`.
- `indexers`: `{chain: unit}`.
- `listeners`: the units whose request lines are counted.
- `v1Automation`: a unit, or null.
- `featured` (optional): the Top pools unit, `domino-featured.service` when absent; null turns its checks off.
- `chains`: `{chain: {rpc, registry}}`.
  - `rpc` is `{providerFile, nodeUrl}` on Robinhood. The provider file is a copy of the reader's; `nodeUrl` is the own node's loopback proxy, and only `http://127.0.0.1:<port>/` is admitted.
  - On Base and Arbitrum, `rpc` is `{chainRpcFile}`: a copy of `/etc/domino/v2/chain-rpc.json`, its keyed URLs coming from the sealed `v2-rpc-*` credentials.
- `balances`: `[{label, chain, address, warnWei, critWei}]`.
- `headLag`: `{chain, warnSeconds, critSeconds}`.
- `disk`: `{path, warnPercent, critPercent}`.

## Files

- **`/var/lib/domino-monitor-public/status.json`** (0644): the levels, the numbers, the addresses and the recent events. It holds no key, URL or token. The dashboard reads it.
- **`/var/lib/domino-monitor/state.json`** (0600, the unit's `StateDirectory`): what the cycles carry, which is:
  - the journal cursors;
  - the confirmed levels and when each was alerted;
  - the registry cursors;
  - hourly counters for 25 hours, and hourly balance samples;
  - the last summary's date and Telegram's update offset.

## In production

`scripts/staging/install_monitor.py` installs the monitor and moves it to newer releases (`--inspect`, `--apply`, `--rollback`). It starts nothing.

1. **The first install** creates:
   - the identity `domino-monitor`, a member of `systemd-journal` only, with no database role;
   - `/etc/domino/monitor` (0700);
   - `/var/lib/domino-monitor-public` (0755).

   **Every release** writes `/opt/domino/financial/releases/<sha>/monitor` (the backend and `api-contracts/v2`, every mode explicit) and `domino-monitor.service`.
   - The unit is wanted at boot by itself, with `Restart=always`.
   - It is not a member of the read path's target. That target stops when the read path does, which is when the monitor matters most.
2. **Private files**, owned by `domino-monitor`, 0600: `config.json`, `providers.json` and `chain-rpc.json`.
3. **Egress.** Collect with `monitor` enabled, `--node-loopback-reads` and `--v2-chains`.
   - The role reaches `api.telegram.org` (`telegram`), Robinhood's RPC hosts (`rpc`), the node's proxy, and Base's and Arbitrum's providers (`chains`).
   - It has no drop-in: its unit binds `monitor.hosts` over `/etc/hosts` itself.
4. **Start.** Run `daemon-reload`, then `systemctl enable --now domino-monitor.service`. `ops_monitor.py --config … once`, run as the unit's user with its credentials, prints one cycle's status without writing anything.

**Live since 5 Oct 2026, 15:26:20 UTC**, from main `b082eb4b`:
- **First attempt:** release `6a966c0f` (14:59 UTC) stopped at the egress installer's `nft -c`. nft 1.0.9 reads `monitor` as its event command where a chain's name goes, so nothing was loaded and nothing started. #354 renamed the chain `ops_monitor`, and the release was installed again from its merge commit.
- **Egress:** applied at 15:26:20 UTC with `monitor` enabled. The collected pins were merged as a union with the previous ones; Chainstack's Arbitrum host gained `208.115.226.174`.
- **Second cycle:** 70 checks, 2 open, both critical: the V1 operator (0.0004 ETH, minimum 0.003) and the V1 publisher (0.0002 ETH, minimum 0.0004) on Robinhood.
- **Snapshot:** `status.json` is 0644, and the local dashboard reads it over ssh.
- **Telegram:** on since 15:41 UTC. The owner sealed `telegram-bot-token` and sent `/start`; `discover` listed the owner's private chat, and its id went into `config.json`.
- **V1 removed (owner, 15:37 UTC):** with V1 automation turned off, the configuration no longer names its unit, its gas peer and settlement timer, or the V1 operator's and publisher's balances (`v1Automation` null). 63 checks, none open.

**The launch alerts (2 Nov 2026), live since 3 Nov 2026 at 13:18:11 UTC** from release `763e9859`, after the V2 automation's move at 13:15:52 UTC; the first cycles held 74 checks at level 0. The monitor moved again with the automation, to `69ccef77` (item 4.5), at 16:48:20 UTC, and again held 74 checks at level 0. A move like it needs two release moves from the same commit, the V2 automation's first:
1. **V2 automation**, so that its passes report `attention` and `gas`. Use `install_v2_automation.py --inspect`, then `--apply`; `daemon-reload`; restart the three instances one at a time, each after the previous one's first pass. Their configurations stay untouched. No V2 module changed between `fe8c41c9` (running since 2 Nov) and this commit except the report itself.
2. **Monitor.** Use `install_monitor.py --inspect`, then `--apply`; `daemon-reload`; then `systemctl restart domino-monitor.service`. `config.json` stays as it is: the one new key, `featured`, is optional and defaults to `domino-featured.service`.
   - The Top pools checks need nothing else: they read the lines the featured service already logs.
   - On its first cycle the monitor finds the list's last publication (30 Oct 12:00:03 UTC on 2 Nov). So if no list is published before the move, the list's age is critical at once.
- **Out of order:** a monitor moved first warns, per chain, that the passes report neither field until the automation follows.
- **Rollback:** `--rollback <commit>` of either installer, `daemon-reload`, then restart.
