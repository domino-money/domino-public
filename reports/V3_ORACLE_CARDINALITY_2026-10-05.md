# v3 oracle cardinality for the V2 automation (5 Oct 2026)

Every V2 action on a v3 vault is anchored on the pool's TWAP through the price anchor (`twapSqrtPrice`, Uniswap's `observe([W, 0])`): a compound over the vault's window, `min(twapSeconds, maxObservationAgeSeconds)` = 300 s in production, and an exit over at least the auto-exit module's 600 s. The anchor only fails closed when a pool's history is shorter than the window ([F1_REGISTRY_ANCHOR.md](../docs/v2/F1_REGISTRY_ANCHOR.md), "Too-short history"). Until this report nothing provisioned the observation cardinality, although the owner decided on 3 Oct 2026 that the operator provides it. Only the EVM test provisioned it, with its own `increaseObservationCardinalityNext(250)`.

This report measures how many slots the pools V2 vaults may use have, how many they need, and what paying for them costs. The owner's decision of 5 Oct, taken on these numbers, is at the end: no slot is paid for, and a v3 vault whose pool cannot guarantee its window is anchored on the publisher's signed price instead. That change is described in [V2_AUTOMATION_BACKEND.md](../docs/v2/V2_AUTOMATION_BACKEND.md), "A v3 vault's anchor: the pool's TWAP or the signed spot". The data and scripts are in [v3-oracle-cardinality-2026-10-05/](v3-oracle-cardinality-2026-10-05/).

## What Uniswap v3 keeps

- **The ring.** A pool keeps `observationCardinality` observations. It writes one only when a swap moved the tick, or when a mint or burn changed liquidity in range.
- **One write per timestamp.** `Oracle.write` returns early when the newest observation already has this block's timestamp.
- **The window.** `observe([W, 0])` reverts `OLD` unless the oldest stored observation is at or before now − W. In a full ring of N slots, that is the N-th newest write.
- **A new pool.** It is created with one slot. Any write in the last W seconds makes the window unreadable.

So W is always readable once N ≥ 1 + the most writes W seconds can hold.

**Nitro chains (Robinhood, Arbitrum One).** Every block of one second shares that second's timestamp (Robinhood has 10 blocks a second, Arbitrum 4). That allows one write a second, so N = W + 1: 301 slots for 300 s, 601 for 600 s.

**Base (OP Stack).** It has one 2-second block, and so one write, every 2 s. So N = W/2 + 1: 151 slots for 300 s, 301 for 600 s.

## Method

| Step | What | Where |
| --- | --- | --- |
| Census | Every pool that emitted a v3 `Swap` log in the window and is the canonical Uniswap v3 pool (`factory()` is the profile's factory and the address is the CREATE2 of its `token0`, `token1` and `fee`). Its `slot0` (`observationCardinality`, `observationCardinalityNext`) was read at the window's end. | Robinhood: 24 h. Base and Arbitrum: 1 h. |
| Writes | The pool's `Swap`, `Mint` and `Burn` logs, replayed. A write is a swap whose tick differs from the tick before it, or a mint or burn with nonzero liquidity in range, counted once per block timestamp. For every second of the period, the writes in (t − W, t] are counted for W = 300 and 600 s, and so are the blocks with a swap. | Robinhood: 24 h, top 60 pools by swaps plus the four WETH/USDG pools. Base: 12 h, 23 pools. Arbitrum: 24 h, 26 pools. |
| Check | The replay was compared with the pools' own rings over the last hour, read slot by slot with `observations(i)`. | 205 of 205 writes (WETH/USDG 0.05%) and 957 of 957 (WETH/USDG 0.01%), identical. |
| Gas | `eth_estimateGas` of `increaseObservationCardinalityNext(n)` from the V2 operator on a one-slot pool, with nothing sent, and the receipts of the EVM test. | All three chains. |

**Sources.**
- Robinhood: Domino's own Nitro node only, through an SSH tunnel to its loopback RPC.
- Base and Arbitrum: the hosted RPC the automation uses (Chainstack).
  - It was reached through `backend/qualify_rpc_forwarder.py`, running on the VM as a transient unit that imports the sealed credential.
  - The keyed URL never left the VM.

**Windows.** Each period ended at:
- Robinhood: block 80,895,387, 15:35 UTC;
- Base: block 52,212,913, 15:46 UTC;
- Arbitrum: block 511,966,657, 15:43 UTC.

## Findings

### The reference pools have their slots; most other pools do not

| Chain | Pool | Slots (`cardinalityNext`) | `observe` 300 s / 600 s |
| --- | --- | ---: | --- |
| Robinhood | WETH/USDG 0.01% `0x52e6…71Ca` | 10,809 | ok / ok |
| Robinhood | WETH/USDG 0.05% `0x69Bf…8d9a` (`priceReferences`) | 3,000 | ok / ok |
| Robinhood | WETH/USDG 0.3%, 1% | 2,500, 2,500 | ok / ok |
| Base | WETH/USDC 0.05% `0xd0b5…F224` (`priceReferences`), 0.3% | 5,000, 2,000 | ok / ok |
| Arbitrum | WETH/USDC 0.05% `0xC696…E8D0` (`priceReferences`), 0.3% | 9,000, 1,200 | ok / ok |

The deployed `DominoPriceAnchor` (`0x8c1e…1f43`) reads all of them over 300 and 600 s. It is the same anchor on the three chains.

Pools that traded, by the slots they have paid for (`cardinalityNext`):

| Chain (window) | Pools | One slot | ≤ 150 | ≤ 300 | ≤ 600 | More |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Robinhood (24 h) | 4,027 | 3,493 (86.7%; 48.5% of the swaps) | 3,580 | 3,713 | 3,730 | 297 |
| Base (1 h) | 1,049 | 626 (59.7%; 17.9% of the swaps) | 835 | 860 | 951 | 98 |
| Arbitrum (1 h) | 183 | 37 (20.2%; 2.2% of the swaps) | 106 | 114 | 120 | 63 |

Pools with one slot still trade heavily. On Robinhood, WETH pairs at 0.01% with one slot took 55,537, 44,516 and 20,005 swaps in 24 hours. On Base, the busiest pool by swaps, `0x2df3…`, a 0.01% USDC pair, has 20 slots. It took about 245,000 swaps in 12 hours. Its median 300 s window held 69 writes, more than three times its slots, and both its windows were unreadable at the end of the period.

### Writes per window reach the bound

| Chain | Writes in 300 s, max (p99) | Writes in 600 s, max (p99) | Bound 300 / 600 s | Blocks with a swap in 300 s, max |
| --- | --- | --- | --- | ---: |
| Robinhood | 300 (297) | 597 (585) | 300 / 600 | 1,302 |
| Base | 150 (150) | 300 (300) | 150 / 300 | 150 |
| Arbitrum | 84 (69) | 166 (132) | 300 / 600 | 156 |

**Blocks against timestamps.** Counting blocks with a swap overstates the need on Nitro: Robinhood's busiest pool had 1,302 such blocks in 300 s, but at most 300 distinct timestamps.

**Pools short of slots.**
- Arbitrum's sampled pools stayed under the bound. Two that the census counts as used have 50 slots:
  - `0x4934…`, 0.01%, wrote 166 times in 600 s, and its 600 s window was `OLD` at the end of the period;
  - LINK/WETH 0.05%, `0x9130…`, wrote 81 times in 300 s.
- A pool with one slot is readable only while it is quiet. On Robinhood the busiest such pools were readable over 300 s 0% to 35% of the day. Bursty ones were readable 65% to 99% of it, but never during their bursts.
- A swap that does not move the tick writes nothing. One Base pool with one slot, `0x551d…`, took about 1,000 swaps in 12 hours without a single write, and its windows stayed readable. A pool with one slot is readable whenever the window holds no write.

### What a pool needs, and what it costs

**Slots.** To be readable at every moment, a pool needs:
- for the compounds' 300 s: 301 slots on Robinhood and Arbitrum, 151 on Base;
- for the exits' 600 s as well: 601 and 301.

Today's peaks on Robinhood and Base are exactly those numbers. Arbitrum's peaks are lower, but nothing bounds them below the protocol's limit.

**Gas.** About 22,410 per slot plus about 39,500 per call, on all three chains:

| Chain | Calls of 100 slots (from 1 slot) | Gas | Base fee, 5 Oct | Cost per pool | At US$2,702/ETH |
| --- | ---: | ---: | --- | ---: | ---: |
| Robinhood, 601 slots | 6 | about 13.7 M | 0.0204 gwei | 0.00028 ETH | US$0.75 |
| Arbitrum, 601 slots | 6 | about 13.7 M | 0.0200 gwei | 0.00027 ETH | US$0.74 |
| Base, 301 slots | 3 | about 6.8 M | 0.005 gwei + 0.001 tip | 0.00004 ETH | US$0.11 |

`eth_estimateGas` from one slot:
- 61,892 for 2 slots, 6,763,017 for 301, 13,487,365 for 601 (Robinhood);
- 6,754,660 for 301 (Base);
- 6,759,444 for 301 (Arbitrum).

The EVM test's three calls of 100 slots on Base's bytecode used 2,252,704 gas each.

**Fitting the executor's caps.** The executor's `maxGas` of 3,000,000 with its 20% margin admits about 110 slots per call, so paying would take calls of about 100 slots.

The cost is paid once per pool, and every vault in that pool shares it. A pool's slots never shrink.

**After the first call.** The ring takes the slots at its next write and keeps the observation it had. The window is readable at most W seconds after the first call, and stays readable.

## Consequences for V2 before the change

- **Every v3 vault on a pool that trades** (most v3 pools on Robinhood and Base) waited as `rpc_call_reverted`. It could not compound or mint a successor.
- **An exit mandate on such a pool** could not fire: its 600 s TWAP read failed the same way. A stop-loss on a quiet pool with one slot fails at the worst moment: the trading that crosses the trigger is what takes its window away.
- **The read API** showed a raw revert, with no way to tell it from another refusal.

## The options, and the owner's decision

| Option | For | Against |
| --- | --- | --- |
| **The operator pays for each pool's slots** (decided on 3 Oct, implemented first) | The chain enforces the TWAP: a manipulator must hold a price for the whole window. | US$0.11 to US$0.75 per new pool, and vaults are permissionless, so the cost grows with users and can be pushed. It needs a budget, and a wait of up to one window after the first call. |
| **The app pays at vault creation** | Closes the push. | One more signature and about 13.7 M gas in the owner's flow on Nitro. Pools that get busier later stay short. |
| **The publisher signs the spot, as on v4** | No gas, no wait, nothing to push. The anchor and the auto-exit module already take a signed observation for any pool, so no contract change is needed. | It trusts the publisher's key, as every v4 vault does. Its stability check holds a price over 60 s, against the TWAP's 300 s or 600 s. |
| A shorter TWAP window (60 s) | Fewer slots needed. | Does not help a pool with one slot that trades, and weakens the anchor. |
| A contract change | — | V2 is frozen, audited and deployed. |

**Decision (owner, 5 Oct 2026): the signed spot**, because paying for slots could grow out of control as Domino gains users. As implemented:
- **The TWAP still anchors when it is guaranteed.** That means the pool's active ring holds the window's bound (301/601 slots on Robinhood and Arbitrum, 151/301 on Base) and already covers it, so no write can uncover it before inclusion. The reference pools qualify.
- **Otherwise the publisher signs the spot.** It uses the same look-back and band as for v4, and the planner takes no TWAP drift for that plan.
- **Exits** compare their trigger with the same anchor.
- **The pass report** says `anchorSource` (`twap` or `signed`).
- **No slot is ever paid for.**

## Reproduce

From [v3-oracle-cardinality-2026-10-05/](v3-oracle-cardinality-2026-10-05/), with the backend's Python and the endpoints on loopback (`chainlib.ENDPOINTS`):
- Robinhood: an SSH tunnel to the node's loopback RPC;
- Base and Arbitrum: the VM forwarder's sockets forwarded by `ssh -L`.

| Script | What it does |
| --- | --- |
| `python sample_pools.py <chainId> <out.json>` | The census over the last hour on Base and Arbitrum. On Robinhood the same steps ran over 24 hours. |
| `python rate_study.py <chainId> <hours> <out.json> <pool>...` | Writes per window per pool. |
| `writes.py` | The replay. |
| `chainlib.py` | The reads, the anchor's `twapSqrtPrice` and `observe` checks, and the gas estimate. |

The JSON files are the outputs of 5 Oct: `census.json`, `writes-*.json` and `gas.json`.
