# read-v6: Domino V2 wallet reads

Contract `1.0.0-rc.1` for the app (F7) of [#283](https://github.com/domino-money/domino/issues/283): one wallet's Domino V2 state and receipts on Robinhood (4663), Base (8453) and Arbitrum One (42161), read from the V2 index. How the index is built, what each table holds and what remains are in [docs/v2/V2_INDEXER_READ_API.md](../../docs/v2/V2_INDEXER_READ_API.md).

Two stored routes of the local reader (`backend/read_api.py`), separate from read-v1 to read-v5:

| Route | Request | Answer |
| --- | --- | --- |
| `POST /v6/read/portfolio` | `{wallet}` | Per chain, the index's freshness and the automation's reporting; the wallet's vaults with their last read state, custody and history totals; the positions it holds or its vaults manage, as last read; its auto-exit mandates with what blocks them; undelivered auto-exit credit; why each vault and mandate waits; the tokens named, with their metadata |
| `POST /v6/read/activity` | `{wallet, limit?, cursor?}` | The wallet's receipts, newest first, `limit` (1–50, default 20) at a time; `nextCursor` continues |

Header `X-Domino-Read-Contract: 1.0.0-rc.1`. Through the gateway the paths are `/internal/read/v6/<route>`, with `--enable-v6` and `DOMINO_BRIDGE_V6_READS=portfolio,activity`, both off by default. The reader serves the routes only with `DOMINO_V2_READ=1` (otherwise `upstream_unavailable`). The Worker route (`/api/read/v6/`) and the app's consumption are the bridge side's: this candidate does not add them.

`wallet` is lower case. The read API does not authenticate wallets: everything here is public chain data, the same for anyone who asks about that address, and the reader refuses browser origins. Errors are read-v1's codes (`ERROR_STATUS_BY_CODE`): `catalogue_database_unavailable` or `upstream_unavailable` (503) when the index cannot be read at all, never a partial answer.

## What an answer says, and what it never says

- **Amounts are raw integer strings** in the token's own units (signed where a flow can go both ways). There is no USD, no APR and no price: every token has `price: null` with `priceReason: "no_qualified_price_source"`, and nothing is summed across chains. `tokens` lists every token an answer names with its metadata as read on chain: `symbol` is untrusted text; `decimals` is `null` when it could not be read, never guessed (`status`: `available`, `partial`, `unavailable`, `not_read`).
- **Per chain** (`chains`, always the three chains in id order):

  | `status` | `reason` | Meaning |
  | --- | --- | --- |
  | `current` | `null` | The indexer observed the head within 180 s, and the index is within 120 s of chain time of it |
  | `stale` | `head_not_observed_recently` | The indexer has not observed the chain for more than 180 s |
  | `stale` | `indexer_behind_head` | The index is more than 120 s of chain time behind the head |
  | `unavailable` | `deployment_not_registered` | No V2 deployment is indexed on this chain |
  | `unavailable` | `never_indexed` | Registered, nothing indexed yet |

  `coverage` is `complete` only when every chain is `current`, otherwise `partial`: one chain out never empties the others. `indexedThrough` (`{number, hash, timestamp}`) is the block every event-derived fact is true at; `finalizedThrough` the chain's finalized block as last observed; `head`, `lagBlocks` and `lagSeconds` how far behind the index is; `lastError` the indexer's last failure. `automationHalted` is the registry's global halt and `operatorsAdmitted` how many operators it admits (automation availability on that chain). `waitingReasons` says whether that chain's automation reports why things wait: `reporting`, `stale` (its last pass is more than 600 s old: the reasons are shown with their age), `unavailable` (the indexer's last read found its file missing or malformed) or `not_configured` (the chain's indexer reads no automation file), with the pass's `block`, `timestamp` and `ageSeconds`.
- **Reads are snapshots.** A vault's state and a position are read at a committed block: `snapshot` is `{number, hash, timestamp}` and `freshness` is `{ageSeconds, status: fresh|stale}`, `stale` once an event touched them after the read or the read is older than two hours. A read that failed is `unavailable` with its `reason`; one not made yet is `not_read`. A zero is only ever a measured zero.
- **Gas** (`tx.gas`) is the receipt's own fields: the sender, gas used, effective gas price, and on OP Stack the L1 data fee. No total is claimed (a stack may charge what the receipt does not state). `tx.finality` is `finalized` at or below the chain's `finalizedThrough`, else `unfinalized`.

## portfolio

- `vaults`: up to 50. Each has its creation (`created`), `members` from its events (`root`: `armed`, `disarmed` with its `disarmReason`, or `exited`; successors: `active`, `withdrawn`, `exited`), `custody` (the root's: `armed` as last read; `reason` from the last `RootDisarmed` after the last `RootRearmed`, `source: event` with `since`, or from the live read alone, `source: live_read`, as `custody_lost`), `pausedBy` (`owner`, `operator`, `unknown` when no pause event explains it, `null` when running), `autoExitEnabled` (its last `ExitModuleSet` is the deployment's auto-exit module), `lastExecution`, `totals` (executions; compounds, fees compounded and service fees per pool token, summed from `Compounded`), `waiting`, and `state`, the vault's own views: pool, quote currency, policy (`mode` `simple` or `domino`), limits, `paused`, `rootArmed`, `stateNonce`, `exitModule`, `lastExecutionAt`, every member's ledger with its two lots, and the reserves (total and idle) per pool token. A vault may be paused while auto-exit protects it (protection without compounding): `paused` is a state, not an error.
- `positions`: up to 100: positions the wallet holds now (as last read), positions its vaults manage (`vault: {address, role: root|successor}`), and positions its S1 actions named that are not read yet. A burned position (the manager's own `Transfer` to zero) is never listed. `state.status` is `live` (owner, `custody` `{approved, subscriber}`, pool, range, liquidity, spot price and tick, `inRange`, `feesOwed` as a collect would pay them, `principalAtSpot`), `unavailable` or `not_read`.
- `mandates`: up to 100: `status` from the events (`active`, `revoked`, `executed` with its anchor price and what was delivered); `expired` (active and past `validUntil`); `vaultIsDomino`; `position` (`root`, `successor`, or `unknown`); `moduleEnabled` (the vault's exit module is this module: a disabled module pauses mandates, it does not revoke them; `null` for a vault that is not a Domino vault); `blockedBy`, what keeps an active mandate from executing now beyond its trigger, in this order: `expired`, `vault_not_domino`, `module_disabled`, `automation_halted`, `custody_lost`, `custody_unread`, `not_in_vault` (empty: it waits for its trigger); `terms` from the module once read (triggers, `receive` `both` or `converted` with `convertTo`, `maxSlippageBps`); `waiting` while active.
- `credits`: auto-exit deliveries the wallet could not receive and has not claimed, per module and token.
- `truncated`: whether a list stopped at its bound.

### `waiting`: why a vault or a mandate waits

What the chain's automation decided for it at its last pass (owner decision of 2 Oct 2026). The automation records it in its journal and writes it to a public file after each pass (docs/v2/V2_AUTOMATION_BACKEND.md); the chain's indexer reads that file into the V2 index, and the answer serves it from there. `null` when the automation has no entry for it or its chain does not report (`chains[].waitingReasons`):

| Field | Meaning |
| --- | --- |
| `reason` | The automation's code: `too_soon`, `gas_not_covered`, `owner_benefit_insufficient`, `earnings_evidence_missing`, `vault_paused`, `root_disarmed`, `trigger_not_reached`, `v2_observation_unstable`, `eligible`, `triggered`, `reverted_<error>`, …; any other code (`[a-z0-9_]{1,100}`) is shown as such |
| `error` | The V2 contract error a `reverted_<error>` reason names (`SpotOutsideBand`, `TriggerNotReached`, …; app spec §4.9), `null` otherwise |
| `since`, `sinceBlock` | The time and block of the first pass that gave this reason, as the automation's journal records them: kept while the reason holds, reset when it changes or clears (and when a later pass's head is earlier, after a reorganization) |
| `checkedAt`, `checkedBlock` | The head of the pass that decided it |
| `lastRevert` | The last presimulation that reverted (`reason`, `error`, `at`, `block`), kept until one passes, or `null` |

## activity

Items, newest first by block time, chain, block and log index, each with `id` (`chain:block:logIndex`), `chainId`, `tx` and its `kind`:

| `kind` | What moved |
| --- | --- |
| `s1_action` | A zap action (create, increase, change range, exit): `inputs`, swap `legs` (measured: venue, amounts in and out), position `steps` (signed: negative paid into the pool), `refunds`, and the tariff (`assisted_swap`, 65 bps) when there was a swap; `intentHash` links it to the signed plan |
| `vault_execution` | An operator execution: fees collected, the swap and its legs, the compound, a successor, and the tariff in each pool token (`automation`, 200 or 400 bps by the vault's mode then) |
| `auto_exit` | A mandate executed: what the vault withdrew, the conversion legs, the fee (`auto_exit`, 20 bps), what was delivered and what was deferred as credit, reserves returned without fee |
| `vault_created` | A vault created, with its policy and limits |
| `vault_event` | The vault's other events in one transaction: owner actions (policy, limits, pause, resume, rearm, withdrawals, recovery, exit module, exitAll) and custody changes |
| `auto_exit_event` | A mandate registered or revoked, a nonce cancelled, a credit claimed |
| `zap_event` | Relayed-action nonces invalidated |

A tariff names its `kind`, `rateBps`, `token`, `amount` and the part `deferred` (owed to the fee recipient because the push failed; never the owner's to spend).

## Checks

```sh
backend/.venv/bin/python scripts/export-read-v6-contract.py --check
node --test api-contracts/read-v6/consumer.test.mjs
```

`backend/tests/test_read_v6_contract.py` runs both, and checks the reader and gateway routes. The schemas, `types.ts`, `schema-data.mjs`, `runtime.d.mts`, the fixtures and `manifest.json` are generated; `runtime.mjs`, this README and `consumer.test.mjs` are written by hand and hashed in the manifest. `fixtures/valid/` holds answers the producer builds; `fixtures/invalid/` the base answers with one defect each, named by the file; every validator must accept the first and refuse the second.
