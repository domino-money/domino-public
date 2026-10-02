# Domino V2 — F6 backend foundation

F6 is the multi-chain backend of V2 (domino-money/domino#283: "perfil por chain; serviços por chain; planner v3/v4; indexação; gás por chain"). This first slice is the foundation the later V2 services build on: the planner, the indexer, the read path and F5's bridge. It adds new modules only. No V1 module, route, contract or manifest changes, and V1 keeps running on Robinhood as it does today.

## The slice and why

Every V2 service needs three things before it can do its own work:

1. **The chain's verified facts:** addresses, tokens, fee ranks, feeds and block-time facts.
2. **A route to that chain**, provisioned per the owner's RPC decision.
3. **One correct way to read Uniswap v3 and v4 pools and positions** (all services except the bridge).

This slice builds exactly those three, and nothing that depends on decisions not yet made:

- The planner needs F3's plan encoding, which is not frozen yet.
- The gas budget needs the owner's per-chain caps.
- The indexer needs deployed V2 contracts.

Those parts come later, on top of this slice (see [What the next slices need](#what-the-next-slices-need)).

## Owner decisions this slice encodes

| Decision | Date | How it is applied |
| --- | --- | --- |
| V2 runs on Robinhood (4663), Base (8453) and Arbitrum One (42161). Elysium waits for its mainnet. | 1 Oct | The registry serves the three enabled profiles. Elysium is listed as pending and never served. |
| Uniswap v3 and v4 only. | 1 Oct | The readers cover exactly those two, at the profile's addresses. |
| Robinhood reads come from Domino's own Nitro node, never the public Robinhood RPC by default. | 1 Oct | Robinhood's endpoints are the read path's own provider file, version 4 only (local node first). Robinhood cannot be named in the V2 file. |
| Base and Arbitrum use hosted RPC: Chainstack first, dRPC as the alternative, Alchemy pay-as-you-go as the fallback, public endpoints only as a last resort. | 2 Oct | Ordered, named endpoints per chain, each with its own limits. A client uses the first three that are not cooling down, so the fourth (public) is used only when one of the first three is cooling. |
| Hosted RPC bills every call, each call inside a batch included. Cut billable calls. | 2 Oct | No `eth_chainId` is ever requested by a client. The head is shared across services. Code hashes are cached per process. Every call is counted per endpoint. |
| Respect each endpoint's limits: log range, batch size, rate. Back off on 429 and move to the next endpoint. | 2 Oct | Per-endpoint `maxLogBlocks`, `maxBatchItems` and `requestsPerSecond`. A 429, 5xx or network failure cools the endpoint down with exponential backoff, and the client fails over. |
| Endpoint URLs carry API keys: read them from configuration or the environment under documented names, and never print them. | 2 Oct | The URL comes from the private file, from the unit's sealed systemd credential `v2-rpc-<chain>-<name>`, or from `DOMINO_V2_RPC_<CHAIN>_<NAME>`: exactly one of the three. Errors, logs and reprs name the endpoint, never its URL. |

## What exists now

All modules are in `backend/`. Tests are in `backend/tests/test_v2_*.py`.

| Module | What it gives a V2 service |
| --- | --- |
| `v2_chains.py` | **Chain registry.** It loads `api-contracts/v2/chains` whole, or refuses it whole: exact keys and types, EIP-55 checksums, file name = `<slug>-<chainId>.json`, the charge-currency rank order, native and wrapped ETH as one currency, and every contract V2 consumes present in the profile's own on-chain verification record. Addresses are lower case. A chain is named by id (`8453`) or profile name (`base-8453`). It exposes `charge_rank`, `verified_codehash`, `v3_tick_spacing` and the exact `block_time`. |
| `v2_abi.py` | **Calls built from the frozen exports** in `api-contracts/v2/abi`. Each function's canonical signature is rebuilt from the exported ABI and must match the compiler's selector list in the same file, so a stale or hand-edited export is refused. The backend does not re-declare an interface. |
| `v2_rpc.py` | **Per-chain endpoints and clients.** See [Endpoints and limits](#endpoints-and-limits). Includes `python backend/v2_rpc.py validate\|check`, the operator's provisioning check. |
| `v2_head.py` | **Shared head follower.** One head per chain, read at most once per `max_age_seconds` for every reader in the process and, through a shared file and its lock, for every service on the host. A head whose block is too old is refused (a stalled node), as V1's reader refuses it. `lag_blocks` pins a few blocks below the latest, for load-balanced providers. |
| `v2_uniswap.py` | **v3 and v4 pool and position reads** at a pinned block. Details below. |

**`UniswapReader` reads, at a pinned block:**

- **A position**, by `PositionRef(dex, positionManager, tokenId)`:
  - owner;
  - the token's individual approval and, on v4, its subscriber (the custody facts the vault relies on);
  - the `PoolRef`, the range and the liquidity;
  - the fees a collect would deliver now;
  - the pool's state at the same block;
  - `principal()` and `in_range`.
- **A pool**, by `PoolRef`:
  - spot price, tick and active liquidity;
  - `swap_fee_pips(direction)`. On v4 this includes the protocol fee, as `ProtocolFeeLibrary.calculateSwapFee` computes it. On v3 the protocol fee is a share of the pool fee, not an extra charge.

**How the reader stays exact:**

- **Fees owed, v4:** the StateView fee growth inside the range since the position's checkpoint, times its liquidity.
- **Fees owed, v3:** `tokensOwed` plus the growth since the position manager's own checkpoint. It is recomputed from the pool's ticks as `Tick.getFeeGrowthInside` and `NonfungiblePositionManager.collect` do, including their 256-bit wrap and 128-bit truncation. Several v3 NFTs with one range share one pool position, so the manager's per-token checkpoint is the one that counts.
- **Addresses:**
  - a v3 pool is the CREATE2 address of the profile's factory and init code hash;
  - a v4 pool is its PoolKey hash;
  - a fee tier the profile does not list (Base has extra tiers) is asked of the factory, as F0 says.
- **Code proofs:**
  - The reader proves the profile's code hashes for the contracts it calls, once per process. It uses the chain's code cache: since Cancun, deployed code cannot change.
  - The v4 PositionManager and StateView embed their PoolManager, so the same proof covers those links.
  - A client pointed at the wrong chain fails here, without a chain-id call.
- **Consistency guards:**
  - v4: the position info must match the pool id, the core liquidity, and the subscriber flag;
  - v3: a live range must have both ticks initialized.
  - Anything else is refused with a fixed error code.
- **No revert is read as a burn.** A v3 token that the manager does not know reverts, and the reader reports `rpc_call_reverted`. A v4 position whose info was cleared reports `v2_position_not_found`. This is the same rule as the V1 NFT reader.

## Endpoints and limits

**Where a chain's endpoints come from:**

- **Robinhood (4663):** the read path's private provider file (`local_config`, version 4 only).
  - Endpoints are `local` (`rpc.domino.money`, the own pruned node, `LOCAL_STATE_BLOCKS` of state) and `fallback-1`, `fallback-2` (archive).
  - Nothing changes for Robinhood.
- **Base (8453) and Arbitrum One (42161):** the private V2 chain RPC file.
  - It is JSON, mode `0600`, in a `0700` directory outside any checkout. These are the same private-file rules as the automation configuration.
  - It is passed with `--chain-rpc-file`. There is no default path.

**Example file.** Keyed URLs stay out of it, sealed as systemd credentials (or in the environment). Only the public endpoint, which has no key, sits in the file.

```json
{
  "schemaVersion": 1,
  "kind": "domino-v2-chain-rpc",
  "chains": {
    "base-8453": {"endpoints": [
      {"name": "chainstack", "host": "<Chainstack Base host>", "archive": true,
       "maxBatchItems": 50, "maxLogBlocks": 10000, "requestsPerSecond": 25},
      {"name": "drpc", "host": "<dRPC host>", "archive": true,
       "maxBatchItems": 50, "maxLogBlocks": 10000, "requestsPerSecond": 25},
      {"name": "alchemy", "host": "base-mainnet.g.alchemy.com", "archive": true,
       "maxBatchItems": 50, "maxLogBlocks": null, "requestsPerSecond": 25},
      {"name": "public", "host": "mainnet.base.org", "url": "https://mainnet.base.org", "archive": false,
       "maxBatchItems": 10, "maxLogBlocks": 2000, "requestsPerSecond": 2}
    ]},
    "arbitrum-42161": {"endpoints": [ "... the same four, Arbitrum hosts ..." ]}
  }
}
```

The numbers above are placeholders for the plan the owner contracts. Measured or documented values on 1 Oct 2026:

| Endpoint | `maxLogBlocks` | `maxBatchItems` | Notes |
| --- | --- | --- | --- |
| Chainstack, paid | 10,000 | per plan | Bills 1 request unit per call, any method. 10,000 blocks is about 42 min on Arbitrum. |
| QuickNode, paid | 10,000 | per plan | If used instead of dRPC. |
| Alchemy, pay-as-you-go | `null` (unlimited) | per plan | The free tier is 10 blocks; do not configure a free key here. |
| dRPC | per plan | per plan | Not measured yet. Confirm with `check`. |
| Base public `mainnet.base.org` | 2,000 | 10 | Rate-limited: it answered 429 to this slice's capture at about 2 calls/s on 2 Oct. Last resort only. |
| Arbitrum public `arb1.arbitrum.io/rpc` | per docs | per docs | Last resort only. |

**What each field does:**

| Field | Meaning |
| --- | --- |
| `name` | `[a-z][a-z0-9-]*`, unique per chain. It is what logs and reports show. |
| `host` | The only host the URL may use. The URL must be HTTPS with no userinfo, port or fragment. A query is admitted, because some providers take the key there. |
| `url` | Optional. If absent, the URL is read from the unit's systemd credential `v2-rpc-<chain>-<name>` or from `DOMINO_V2_RPC_<CHAIN>_<NAME>`. Exactly one of the three must exist, or the configuration is refused (`v2_rpc_url_missing`, `v2_rpc_url_ambiguous`). A credential that is not a plain regular file of at most 2,048 ASCII bytes is refused (`v2_rpc_credential_unreadable`). |
| `archive` | `true` if the endpoint serves state at any block. A non-archive endpoint is assumed to keep `RECENT_STATE_BLOCKS` (128) below the head, the geth and Nitro default. History reads older than that start at the first archive endpoint. |
| `maxBatchItems` | A JSON-RPC batch goes out in envelopes of at most this many calls. |
| `maxLogBlocks` | An `eth_getLogs` range wider than this is split into windows and merged in order (`null`: no split). |
| `requestsPerSecond` | Calls are paced to this rate, each call of a batch counted (`null`: not paced). A call that would wait more than 2 s, or past the read's own deadline, is refused locally as `http_429`, and the client moves on. |

**Documented names.** The URL lives in one of these systemd credentials, in one of these variables, or in the file's `url`:

| Chain | Credentials (`LoadCredentialEncrypted=`) | Variables |
| --- | --- | --- |
| Base | `v2-rpc-base-8453-chainstack`, `v2-rpc-base-8453-drpc`, `v2-rpc-base-8453-alchemy`, `v2-rpc-base-8453-public` | `DOMINO_V2_RPC_BASE_8453_CHAINSTACK`, `DOMINO_V2_RPC_BASE_8453_DRPC`, `DOMINO_V2_RPC_BASE_8453_ALCHEMY`, `DOMINO_V2_RPC_BASE_8453_PUBLIC` |
| Arbitrum One | `v2-rpc-arbitrum-42161-chainstack`, `v2-rpc-arbitrum-42161-drpc`, `v2-rpc-arbitrum-42161-alchemy`, `v2-rpc-arbitrum-42161-public` | `DOMINO_V2_RPC_ARBITRUM_42161_CHAINSTACK`, `DOMINO_V2_RPC_ARBITRUM_42161_DRPC`, `DOMINO_V2_RPC_ARBITRUM_42161_ALCHEMY`, `DOMINO_V2_RPC_ARBITRUM_42161_PUBLIC` |

The credential names are `v2-rpc-` + the profile name + `-` + the endpoint name; the variables `DOMINO_V2_RPC_` + the profile name + `_` + the endpoint name, upper case with `-` as `_`. **Prefer the credential** on the VM: systemd decrypts it for the unit alone at each start (`LoadCredentialEncrypted=v2-rpc-base-8453-chainstack:/etc/credstore.encrypted/v2-rpc-base-8453-chainstack`), sealed with the host's key like the automation's keystore passwords (docs/AUTOMATION_PILOT_CONFIGURATION.md, "The signers' keys"), so a copy of the configuration or a backup reveals no key. The variables remain for other hosts; there, prefer a systemd `EnvironmentFile=` (0600) or the private file over `Environment=`, which `systemctl show` prints. The V2 automation's credentials are listed in [V2_AUTOMATION_BACKEND.md](V2_AUTOMATION_BACKEND.md).

**Failover and backoff:**

- A 429, a 5xx or a network failure from a provider cools that endpoint down for 1 s. The pause doubles while it keeps failing, up to 60 s, and resets on a success.
- While an endpoint cools, calls to it are refused locally: nothing is sent and nothing is billed. Clients skip it, and the fourth endpoint takes its place.
- If every endpoint cools, reads fail with `v2_rpc_endpoints_cooling` instead of retrying.
- A JSON-RPC-level error inside a 200 reply is not treated as a rate limit. Only HTTP 429 is. Revisit this per provider during the F8 checks.

**Clients:**

| Client | Used for |
| --- | --- |
| `ChainReadRpc` | Current state. It may be seeded with the follower's head (`anchor=`), so a read spends no call on the head. A switch to another endpoint proves the head again. |
| `ChainHistoryRpc` | Pinned historical reads. Each operation starts at the first endpoint that keeps the state it reads. On Robinhood that is exactly V1's rule: the own node within 15,000 blocks of the head, the fallback beyond. |
| `ChainIndexRpc` | History reads plus `eth_getLogs`, for indexers. |

All three are the V1 read path's failover clients (`rpc_failover`): one deadline and one request budget across endpoints, and pinned blocks proven again on every switch. None of them requests `eth_chainId`; asking it is refused as `method_not_read_only`.

**What a read costs.** These counts are measured in the tests (`test_v2_uniswap.py`), with the head from the follower:

| Read | Calls |
| --- | --- |
| v4 position | 9 (1 + 8). |
| v3 position | 8. Add 1 for a fee tier the profile does not list. |
| Code proofs | 2 `eth_getCode` per Uniswap version, once per process. |
| Head | One poll per chain per `max_age_seconds` for the whole host. |

## What the owner must provision (F8)

1. **Contract the hosted endpoints** for Base and Arbitrum One:
   - Chainstack, the primary, with archive if the indexers will read old state;
   - dRPC, the alternative;
   - Alchemy, the fallback: add Base and Arbitrum to the existing pay-as-you-go account.

   The public endpoints need no contract.
2. **Write the private V2 chain RPC file** above, with each endpoint's host and its plan's limits. Seal each keyed URL as its `v2-rpc-<chain>-<name>` credential, typed once at the prompt and never written in plain:

   ```sh
   sudo systemd-ask-password -n "Chainstack Base URL:" | sudo systemd-creds encrypt --with-key=host --name=v2-rpc-base-8453-chainstack - /etc/credstore.encrypted/v2-rpc-base-8453-chainstack
   ```

   or put it in the file's `url` or its `DOMINO_V2_RPC_*` variable. `validate` and `check` below read the credential when they run with it, for example under `systemd-run --pipe --property=LoadCredentialEncrypted=v2-rpc-base-8453-chainstack:/etc/credstore.encrypted/v2-rpc-base-8453-chainstack …`.
3. **Admit each provider host** in the VM's egress policy (see `docs/CONTINUOUS_EGRESS.md`).
4. **Check each chain:**

   ```sh
   backend/.venv/bin/python backend/v2_rpc.py validate --chain base-8453 --chain-rpc-file /path/to/v2-chain-rpc.json
   backend/.venv/bin/python backend/v2_rpc.py check --chain base-8453 --chain-rpc-file /path/to/v2-chain-rpc.json
   ```

   `check` is read-only, and its report names no URL. For each endpoint it proves:
   - the chain id, the only `eth_chainId` V2 sends;
   - a fresh head;
   - the code hash of every contract the profile verified at that head;
   - for an endpoint marked `archive`, the profile's code at the profile's own verification block.

   It exits non-zero on any mismatch.
5. **Robinhood:** nothing new. V2 uses the read path's provider file. `check --chain robinhood-4663 --provider-file …` runs the same proofs against it.

## How a V2 service uses it

```python
from v2_chains import DEX_V4, chain
from v2_head import HeadFollower
from v2_rpc import configured_endpoints, load_chain_rpc_config
from v2_uniswap import PositionRef, UniswapReader

profile = chain('base-8453')
endpoints = configured_endpoints(profile, chain_rpc_config=load_chain_rpc_config(path))  # once per process
follower = HeadFollower(endpoints, max_age_seconds=2, shared_path='/run/domino-v2/base-8453.head.json')

head = follower.head()
reader = UniswapReader(profile, endpoints.read_rpc(anchor=head.block, batch_reads=True))
position = reader.position(PositionRef(DEX_V4, profile.uniswap.v4.positionManager, token_id), head.block)
reader.assert_canonical(head.block)  # before acting on what was read
```

## What the next slices need

**Planner (F3, F6):**
- F3's plan encoding.
- Gas per chain:
  - ETH/USD from the profile's Chainlink feed (`gasPrice.chainlinkEthUsd`). Gate it on the L2 sequencer uptime feed where the profile has one (Base, Arbitrum): up, and past a grace period.
  - The L1 data cost per stack: Nitro's `NodeInterface.gasEstimateL1Component`; on OP Stack, `GasPriceOracle.getL1Fee` plus the operator fee.
- The owner's per-chain gas caps. V1's US$20/day budget is tied to Robinhood's Chainlink feed inside SQL (migrations 032, 037, 038, 040 and 046).
- Measured gas units per action: the V1 planner overestimated by about 2× (#282).

**Indexer:**
- Event decoding from the ABI exports. `v2_abi` reads functions only today.
- Windows in seconds, converted through block timestamps: blocks are not uniform on Nitro.
- Per-chain finality: the `safe` and `finalized` tags differ by stack.
- A database per chain, or chain-aware tables. Today's schema is single-chain (Elysium spec §6.1).
- `ChainIndexRpc` already splits log ranges per endpoint.

**Read path:**
- A new V2 API contract package.
- Per-chain routing in the gateway.
- Finding a wallet's positions:
  - v3's position manager is enumerable per owner;
  - v4's is not, so it needs an indexer or a provider NFT API.
- Valuation per chain.

**F5 (bridge):**
- F5's open PR (#287) reads the profiles directly and its destination RPCs from `DOMINO_CROSSCHAIN_RPC_URL_<chainId>`. It notes that this reading belongs on this registry.
- To move over, F5 takes chain ids, the stable and wrapped currencies and `bridge.appFeeBps` from `v2_chains.chain(...)`.
- For the fee proof on the destination chain, F5 reads through `configured_endpoints(...)` and a `ChainIndexRpc`. That puts it behind the same endpoints, limits and billing counters as every other V2 service.
- F5 also takes secrets from systemd credentials. Moving to one secret convention for both fronts is a small follow-up.

**Billing (next lever):** Multicall3 aggregation. Every profile lists Multicall3, and the registry verifies its code hash. Aggregating a position read through it would take a v4 read from 9 calls to 2, and a v3 read from 8 to 2.

**Head sharing topology:** which service user owns `/run/domino-v2/`, and its group permissions. The file holds public chain data only.

**v3 TWAP reads** (`observe`), for the v3 price anchor (F1's `IDominoPriceAnchor`).

**The charge-currency selection rule** belongs to F2's contracts. A backend mirror, for quoting `intent.feeToken`, must follow F2's implementation, not this document.

**Elysium:** enable its profile when every `enableWhen` condition holds. The registry and the clients need no change.

## Verification in this slice

| Test | What it checks |
| --- | --- |
| `test_v2_chains.py` | Every registry rule is pinned by a case only that rule refuses. The DEX ids are checked against `DominoV2Types.sol`. |
| `test_v2_abi.py` | All 19 exports (137 functions) load with the compiler's selectors. A stale export is refused. |
| `test_v2_rpc.py` | Configuration shape, URL rules and the documented variables; Robinhood's provider file; batch envelopes and log windows per endpoint; pacing, cooldown and backoff; no `eth_chainId` from any client; failover logs naming endpoints only; history start per endpoint, including V1's Robinhood window; the `check` command. |
| `test_v2_head.py` | One poll per max age; stalled heads refused; lag; one read shared by concurrent processes through the file. |
| `test_v2_uniswap.py` | Both readers over a fake chain answering only the exported ABIs. The v3 inside-growth formula matches the V1 accounting's over random cases. CREATE2 pool addresses match the real pools the profiles recorded. A replay of real Base v3 positions matches the position manager's own `collect`. |
| `test_v2_uniswap_evm.py` (Anvil, `DOMINO_TEST_EVM=1`) | Against the official v4 contracts, the fees the reader reports equal what the PositionManager pays the owner on collect, and the custody facts are the approval and subscription the owner gave. |

**Mutation check.** Every guard in the five modules was deleted or neutralized one at a time: 170 single-guard mutants, run against all V2 test modules, and every one fails a test. Guards that another rule already enforced were removed rather than kept unpinned:
- the provider file's local-first check (`checked_config` enforces it);
- a second v3 "pool not found" condition;
- an empty-range log check.

Two masks in the v3 fee arithmetic were folded, because they are equivalent modulo 2**128.

**The real v3 positions** in `fixtures/v2-base-v3-positions.json` were captured read-only from Base's public RPC on 2 Oct 2026. Three positions at their own pinned blocks: two in range with fees, and one exactly on its upper tick. With each, the position manager's own `collect`, simulated from the owner at that block.
