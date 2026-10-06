# read-v6: Domino V2 wallet reads

Contract `1.1.0-rc.1` for the app (F7) of [#283](https://github.com/domino-money/domino/issues/283): one wallet's Domino V2 state and receipts on Robinhood (4663), Base (8453) and Arbitrum One (42161), read from the V2 index. How the index is built, what each table holds and what remains are in [docs/v2/V2_INDEXER_READ_API.md](../../docs/v2/V2_INDEXER_READ_API.md).

Two stored routes of the local reader (`backend/read_api.py`), separate from read-v1 to read-v5, and three live chain reads (below):

| Route | Request | Answer |
| --- | --- | --- |
| `POST /v6/read/portfolio` | `{wallet}` | Per chain, the index's freshness and the automation's reporting; the wallet's vaults with their last read state, custody and history totals; the positions it holds or its vaults manage, as last read; its auto-exit mandates with what blocks them; undelivered auto-exit credit; why each vault and mandate waits; the tokens named, with their metadata |
| `POST /v6/read/activity` | `{wallet, limit?, cursor?}` | The wallet's receipts, newest first, `limit` (1–50, default 20) at a time; `nextCursor` continues |
| `POST /v6/read/chain-pools` | `{chainId, token, pairedToken?}` | The token's pools on a chain, read at its head (below) |
| `POST /v6/read/chain-balances` | `{wallet, tokens?}` | A wallet's balances on each chain asked, every chain's base currencies by default |
| `POST /v6/read/chain-tokens` | `{chainId, query, limit?}` | The tokens Domino knows on Base or Arbitrum One that match a query |

Header `X-Domino-Read-Contract: 1.1.0-rc.1`. Through the gateway the paths are `/internal/read/v6/<route>`, with `--enable-v6` and each route named in `DOMINO_BRIDGE_V6_READS`, both off by default. The reader serves the stored routes only with `DOMINO_V2_READ=1` and the chain reads only with `DOMINO_V2_CHAIN_READS=1` (otherwise `upstream_unavailable`). The Worker forwards `/api/read/v6/<route>` for the routes its `ENABLED_V6_READS` names.

`wallet` is lower case. The read API does not authenticate wallets: everything here is public chain data, the same for anyone who asks about that address, and the reader refuses browser origins. Errors are read-v1's codes (`ERROR_STATUS_BY_CODE`): `catalogue_database_unavailable` or `upstream_unavailable` (503) when the index cannot be read at all, never a partial answer.

## What an answer says, and what it never says

- **Amounts are raw integer strings** in the token's own units (signed where a flow can go both ways). USD comes only from a qualified source ([below](#qualified-usd)): each token in `tokens` has its `price` or the `priceReason` it has none, and nothing is summed across chains. There is no APR. `tokens` lists every token an answer names with its metadata as read on chain: `symbol` is untrusted text; `decimals` is `null` when it could not be read, never guessed (`status`: `available`, `partial`, `unavailable`, `not_read`).
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

## Qualified USD

`1.1.0-rc.1` (0xdecimal's item 4). The rules are the owner's decision #22 of 2 Oct 2026 (F7 §6.3) and the owner's answers of 5 Oct 2026. The backend's code is `backend/v2_chain_reads.py`. A token has a USD price from one of three sources and from nothing else:

| `price.source` | Token | Price |
| --- | --- | --- |
| `chain_stable` | The chain's stable, its rank-1 charge currency (USDG on Robinhood, USDC on Base and Arbitrum One) | US$ 1, fixed (`"1.000000000000000000"`) |
| `chainlink_eth_usd` | ETH (the zero address) and its wrapped token | The profile's Chainlink ETH/USD. It counts while its round is no older than the feed's heartbeat at the block read (24 h on Robinhood, 1,200 s on Base, 1,755 s on Arbitrum). On Base and Arbitrum the sequencer must also have been up for more than an hour. The round is `ethUsd`: `{feed, usd, roundId, updatedAt}` |
| `pool` | Any other token | Its deepest pool against one of those, among the app's candidates (Uniswap's standard hookless v4 keys and the v3 tiers the factory enables), at that pool's price. It counts only when the pool releases at least US$ 10,000 of the partner as the token is sold into it until its price falls 10%. This is the featured pools' reference depth, walked tick by tick and read in the same block as the price. `pool` is that pool, `depthUsd` that depth. A pool against ETH or WETH carries its `ethUsd` |

- **Format.** `usd` has 18 decimal places and amounts in USD have 6, all rounded down. Every non-stable price has the `snapshot` it was read at.
- **Reasons.** Without a price, `priceReason` says why:

  | `priceReason` | Why |
  | --- | --- |
  | `no_qualified_price_source` | The reader has no endpoints for that chain, or the chain reads are off |
  | `price_read_failed` | The read failed or ran past its 3 s budget, or the depth of one of the token's pools could not be read; it is not kept |
  | `pricing_limit_reached` | Beyond what one read prices: 32 tokens a chain, as many tokens' pools as one call of 512 reads holds, and the depths of 1,024 ticks. A pool of the token left unmeasured might have qualified; it is not kept |
  | `decimals_unknown` | The token's decimals could not be read |
  | `eth_usd_stale` | The feed's round is past its heartbeat |
  | `sequencer_down` | The sequencer is down or within its grace hour; only the stable keeps its price |
  | `no_pool` | No pool against a base currency |
  | `pool_depth_below_floor` | No pool reaches the floor |
  | `pool_depth_unmeasurable` | The walk would take more than 300 steps, or a word of the pool's map could not be read |
  | `price_below_precision` | Below 10⁻¹⁸ USD |

- **Caching.** Prices are kept 30 s per chain and token.
- **Checks.** The contract checks:
  - each price against its chain's profile (`PRICE_PROFILES`): the stable is 1; ETH and WETH come from that feed within its heartbeat; a pool contains the token and a base currency, has no hooks and is at or above the floor;
  - each balance's value and each total to the micro-dollar.

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
| `reserves_returned` | A closed vault's reserves paid to its owner by a `returnReserves()` someone else sent (`returnedBy`, the transaction's sender; `byOperator` when the registry admitted it as an operator before that transaction): the automation sends one once the owner closed the root and no successor is active. `reservesReturned` lists each token paid, at one `stateNonce`. The owner's own withdrawals stay `vault_event` |
| `auto_exit_event` | A mandate registered or revoked, a nonce cancelled, a credit claimed |
| `zap_event` | Relayed-action nonces invalidated |

A tariff names its `kind`, `rateBps`, `token`, `amount` and the part `deferred` (owed to the fee recipient because the push failed; never the owner's to spend).

## Checks

```sh
backend/.venv/bin/python scripts/export-read-v6-contract.py --check
node --test api-contracts/read-v6/consumer.test.mjs
```

`backend/tests/test_read_v6_contract.py` runs both, and checks the reader and gateway routes. The schemas, `types.ts`, `schema-data.mjs`, `runtime.d.mts`, the fixtures and `manifest.json` are generated; `runtime.mjs`, this README and `consumer.test.mjs` are written by hand and hashed in the manifest. `fixtures/valid/` holds answers the producer builds; `fixtures/invalid/` the base answers with one defect each, named by the file; every validator must accept the first and refuse the second.

## Chain reads: chain-pools, chain-balances, chain-tokens

The app spec's §6.2 reads that need the chain itself (0xdecimal's list of 5 Oct 2026), so the app lists pools and balances without moving the wallet to another network; it still does, to sign. They read the chains when asked (`backend/v2_chain_reads.py`): Robinhood through Domino's own node, Base and Arbitrum through the hosted endpoints of the V2 chain RPC file, one Multicall3 call per chain at its head (`chain-pools` at most three more, for the depths), cached for a few seconds. They take the reader's provider lane; `chain-tokens` reads no chain and takes the stored lane. Their `limitations` are `usd_from_qualified_sources_only`, `token_metadata_untrusted`, `state_as_of_last_read` and `no_execution_or_signing`, in that order.

- **`chain-pools`** reads the pools the app reads today through the wallet: `token` against the chain's base currencies (its charge currencies: the stable, the native currency and its wrapped token) or against `pairedToken` alone, in Uniswap's standard hookless v4 keys (fee 100, 500, 3000 or 10000 with spacing 1, 10, 60 or 200) and the v3 fee tiers the factory enables (Base adds 200, 300 and 400). Native ETH has no v3 pool; in v3 it pairs as WETH. A pool is listed when it exists, is priced and holds liquidity: partners ETH and WETH first, then the stable, then by active liquidity, at most 32 (`truncated`).
  - Each pool: `pool` (its `PoolRef`), `id` (v4's pool id) or `address` (v3's pool), `sqrtPriceX96`, `tick`, active `liquidity`, `lpFeePips` (the tier's), `protocolFee` as the pool reports it, and `swapFeePips` per direction (v4's protocol fee taken before the LP fee; v3's protocol fee is a share of the LP fee, not on top of it).
  - `market` is the pool's depth within the band ([Qualified USD](#qualified-usd)), measured in the same block as the pool's price: `{status: "measured", reference, depthUsd}`. `reference` is the token's partner, the stable or ETH/WETH. Otherwise it is `{status: "unavailable", reason}`, with `reason`:
    - `no_qualified_reference`: a pair without a base currency;
    - `eth_usd_stale`, `sequencer_down` or `price_read_failed`: an ETH or WETH partner without a feed price; `price_read_failed` also when the read of the pool's depth failed;
    - `pool_depth_unmeasurable`: the walk would take more than 300 steps, a word of the pool's map could not be read, or the pool did not fit the read's depth reads (512 bitmap words and 1,024 ticks; the pools deepest by active liquidity are measured first).

    There is no TVL, volume or APR: they need history.
  - `tokens`: every currency the answer names (`token`, `pairedToken` and each pool's pair), sorted, with its metadata as read (`available`, `partial`, `unavailable`) and its `price` or `priceReason`.
    - The base currencies are priced in this same read.
    - The token is priced in this read when no `pairedToken` was asked, because its pools against the base currencies are all here.
    - Every other token is priced from its own pools.
  - `snapshot` is the block read; `freshness` is its age at `servedAt`, `fresh` up to 60 s.
- **`chain-balances`**: per chain asked (ascending), `current` with the `snapshot` read and each token's `balanceRaw` (`read`, or `unavailable` when the call failed), or `unavailable` with `chain_not_configured` or `chain_read_failed` and every balance unavailable. `coverage` is `complete` when every chain is `current`. Without `tokens`, every chain's base currencies; with them (at most 24, no repeats), exactly those, in the order asked. The native currency is the zero address.
  - Each balance has its token's `price` or `priceReason`, and `valueUsd`: the balance at that price, rounded down to the micro-dollar, when the balance, its decimals and the price are known.
  - A chain's `totalUsd` sums its balances. It exists only when the chain is `current` and every balance above zero has a value (a zero balance needs no price).
  - The answer's `totalUsd` sums the chains, only when every chain has its total (the owner, 2 Oct: no sum across chains without all of them).
- **`chain-tokens`** (Base and Arbitrum One; Robinhood's search is read-v3's): the tokens Domino knows there. Like read-v3's search it covers known tokens only (`coverage: "known_tokens_only"`). Each token's `sources`, in this order:
  - `profile`: the chain's own currencies;
  - `uniswap_default_list`: the Uniswap Labs Default token list, pinned in the release with its version and SHA-256 (`tokenList`), GPL-3.0;
  - `v2_activity`: tokens the V2 index read in full;
  - `looked_up`: tokens a `chain-pools` read found priced pools for, as Robinhood's catalogue learns from visitors.

  A query matches an address exactly, else a symbol exactly, then a symbol's prefix, then a word of the name, then either anywhere; within a rank the curated sources first. At most `limit` (1–24, default 20; `truncated`).

