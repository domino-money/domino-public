# Production monitor

`backend/ops_monitor.py` watches what the V2 rollout runs on: the services, the chains and the operators' balances. Each minute it does three things:
- checks everything below;
- alerts on Telegram when a level changes;
- writes a public status snapshot for the operator's dashboard.

It reads only. It never signs, sends no transaction and serves nothing.

## What it checks

| Check | Source | Warning | Critical |
| --- | --- | --- | --- |
| Each service | `systemctl show` | `activating` | not loaded, `failed`, `inactive` |
| Each timer and its service | `systemctl show` | the service's last run failed | timer not active |
| V2 automation, per chain | its pass lines (journal) | 3 passes in a row with an error; a signer problem held for 3 passes | no pass for 4 cadences (at least 120 s); 10 errors in a row; signer refused (`balance_low`, `not_admitted`, `has_code`) |
| V2 indexer, per chain | its round lines | | no round for 5 min |
| V1 automation | its cycle lines | no cycle for 15 min | |
| Listeners (read, gateway, auth, plan, crosschain, execution-status) | their request lines | 5 responses 5xx in an hour | 20 in an hour |
| Operators' balances | `eth_getBalance` at the head | below the warning floor | below the critical floor |
| The own node's lag | its loopback proxy, never a fallback | 3 min | 10 min, or no answer |
| Reads per chain | the services' endpoint files and sealed URLs | a chain's reads failed | |
| Disk | `/` | 85% | 95% |

**Events** are sent as they happen, each once:
- a V2 execution submitted, confirmed or reverted;
- an intent in `attention`;
- new V2 vaults;
- an automatic restart;
- every log of the V2 registry, decoded with the exported ABI.

The registry's administrative events are critical: halt, operator, publisher, fee recipient, guardian, governance, router and scheduled changes.

A unit's first read (its last 15 minutes) is history: it is counted, never announced.

**Alert policy:**
- A level counts once it holds for 2 cycles, so a restart or one late pass alerts no one.
- A critical alert repeats every 3 hours while it lasts.
- A return to normal is announced once.

**Daily summary:** at 12:00 UTC, the last 24 hours:
- passes, errors, sends and confirmations per chain;
- each balance and what left it (decreases only, so a top-up does not hide spending);
- the listeners' requests by route and status;
- the registry's events and the new vaults;
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
