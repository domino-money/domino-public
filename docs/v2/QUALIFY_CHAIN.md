# Qualifying a new chain for V2 (day 1)

`scripts/v2/qualify-chain.mjs` answers, in one run of a few minutes, whether Domino V2 can deploy and run on a chain
that has just published its chain id, RPC and contracts. It also drafts the chain's profile
(`api-contracts/v2/chains/<slug>-<chainId>.json`) from verified values only. It was built for Kinetiq's Elysium, an
Arbitrum Orbit chain that settles to HyperEVM with HYPE as gas (placeholder: `api-contracts/v2/chains/elysium.json`).
It works for any Nitro chain.

- **Read-only.** It holds no key, signs nothing and sends nothing. Every RPC method it can call is a read, and a run
  stops at 200 calls (`--max-calls`).
- **Not a release input** ([FREEZE.md](FREEZE.md)). It imports `deploy.mjs`'s constants and functions and changes
  nothing frozen.
- **The RPC URL never reaches the output.** The node's own messages are redacted by value.

## Day 1

1. **Put the provider URL where only you can read it.** Use one of:
   - an environment variable (`--rpc-env ELYSIUM_RPC_URL`);
   - an owner-only file holding `{"url": "https://..."}` (`chmod 600`, `--rpc-file`).
2. **Copy Uniswap's published addresses for the chain into a file in the profile's own shape.** Every key is optional:
   ```json
   {"v3": {"factory": "0x…", "positionManager": "0x…", "quoterV2": "0x…", "swapRouter02": "0x…"},
    "v4": {"poolManager": "0x…", "positionManager": "0x…", "stateView": "0x…", "quoter": "0x…"},
    "universalRouter": {"address": "0x…", "version": "2.1.2"},
    "sources": ["<Uniswap's deployment page>"]}
   ```
   The version is Uniswap's word: no chain read shows it.
3. **Run it, writing outside the checkout** (it refuses a directory inside it):
   ```sh
   node scripts/v2/qualify-chain.mjs --rpc-env ELYSIUM_RPC_URL --pending elysium --chain-id <published id> \
     --uniswap ~/elysium-day1/uniswap.json --stable <USDC address> --out ~/elysium-day1/run-1
   ```
   - `--wrapped-native` is optional. Without it the tool takes WHYPE from `NonfungiblePositionManager.WETH9()`.
   - `--pending elysium` takes the slug, name, `HYPE` and the stack from the placeholder.
4. **Read the console.** It prints one line per check (`PASS`, `FAIL` or `UNKNOWN`, with its evidence in
   `report.json`), then the two verdicts and every bootstrap.
   - The **deploy** verdict counts the chain facts, CreateX, a canonical Safe, Permit2, every Uniswap contract, the
     wrapped native and `deploy.mjs`'s own `checkDependencies` run on the draft.
   - The **run** verdict counts the chain facts, `eth_simulateV1`, Permit2, Multicall3, Uniswap, both tokens and a
     WHYPE/stable v3 pool with liquidity.
   - **A chain with one Uniswap version** (Elysium: v4). An input that names no address of a version means the chain
     has none of it. The verdicts leave that version's checks out, and the run takes v4's liquidity in place of v3's.
     The draft names it `null`, and the funding counts that version's steps (8 for v4).
5. **Do not commit the draft as it is.** `profile-draft.json` keeps `"enabled": false`, and every field it could not
   verify is `null`. `report.json` lists those fields (`unverifiedFields`) and what today's schema cannot express
   (`schemaGaps`).
   - Never put the draft in `api-contracts/v2/chains/`. No profile shape is complete and disabled, so the backend's
     registry would refuse the whole directory.
   - `gasPrice.poolNativeUsd` names the liquid wrapped-native/stable pool with the most in-range liquidity. Which pool
     prices HYPE is the owner's choice: confirm it against `liquidity.v3` and `liquidity.v4`.
   - `bridge.providers` starts empty, so S2 stays off on the chain until Relay or Across serve it.
   - The enabled profile also replaces `elysium.json` in the same change.

## After the qualification, in order

1. **Bootstrap**, if the report needs one: CreateX, the Arachnid proxy or Multicall3 from their presigned transactions,
   or Safe 1.3.0 through the Arachnid proxy. Rehearse each on a fork first.
2. **The profile and the release candidate, in one pull request:**
   - `elysium-<id>.json` from the draft: enabled, the router's version, the pool that prices HYPE and no bridge
     provider. It replaces `elysium.json`.
   - `<id>` in `deploy.mjs`'s `ENABLED_CHAINS`, with the manifest rewritten (`release-manifest.mjs --write`). It is
     already there for 99901 (6 Nov 2026), so for Elysium this release input is unchanged.
   - What `schemaGaps` names: the profile tests, and the API schemas that list the chain ids (a contract change the
     app sees).

   After main's own CI passes on the merge, the owner tags `v2-release-YYYY-MM-DD` ([FREEZE.md](FREEZE.md)).
3. **Governance:** the Safe 1.3.0 ([GOVERNANCE_SAFE.md](GOVERNANCE_SAFE.md)), then the chain's roles file.
4. **Funding, in HYPE:** the preflight's worst case for the deployer, and gas for the guardian, the operator and the
   publisher.
5. **Deployment:** [DEPLOYMENT.md](DEPLOYMENT.md), from `prepare` to `verify` at `finalized`, then Sourcify.
6. **Services:** the backend's units, egress and Workers, and the app (0xdecimal's), come after the contracts.

## What it checks

| Section | Checks |
| --- | --- |
| Chain | `eth_chainId`; the head's age; the block time over the last 100, 1,000 and 10,000 blocks; the `safe`/`finalized` lag; the ArbOS version (`ArbSys.arbOSVersion()` minus 55); the L1 component of the largest release step (vault.v4's ~42 KB `deployCreate3`) through `NodeInterface.gasEstimateL1Component`, against `deploy.mjs`'s 16,777,216 gas cap; the EIP-1559 base fee; TSTORE, TLOAD, MCOPY and PUSH0 (an `eth_call` with a state override, else a creation call, then one opcode at a time); `eth_simulateV1` the way the V2 plan API calls it; that the pinned block is still canonical at the end |
| Infrastructure | CreateX against `CREATE_X_CODE_HASH`; the Arachnid proxy, the Safe Singleton Factory and Multicall3 against the hashes the three profiles record; Permit2's domain separator, and its bytes against each profile's once its chain id and domain separator are substituted; every `SAFE_SINGLETONS` entry and each version's canonical SafeProxyFactory (code hash from safe-deployments, and the proxy it creates against `SAFE_PROXY_RUNTIME_HASHES`); the nonces of the keyless senders, as evidence that unprotected (pre-EIP-155) transactions are accepted |
| Uniswap | v3: `feeAmountTickSpacing` for 100/500/3000/10000; `factory()` and `WETH9()` of the position manager, QuoterV2 and SwapRouter02; SwapRouter02's `positionManager()`; the pool init code hash, proved by CREATE2 for a pool `getPool` names. v4: `poolManager()` of PositionManager, StateView, V4Quoter and Universal Router; PositionManager's `permit2()` and `WETH9()`; PoolManager's bytes against each profile's once its own address is substituted. Every contract's size and code hash |
| Tokens | The wrapped native and the stable: code, symbol, decimals, and an upgradeable proxy's implementation. Every v3 fee tier's WHYPE/stable pool (`liquidity()`, `slot0`, price), and the hookless v4 pools |

A byte comparison means something only where the immutables are known. Permit2, PoolManager, StateView, V4Quoter,
QuoterV2 and the v3 factory are compared after substitution. For the others, the position managers, SwapRouter02 and
Universal Router, the report says it is not meaningful and the cross-checks above decide.

## Bootstrap

When CreateX, the Arachnid proxy or Multicall3 is absent, the report gives what its published presigned transaction
needs:
- the sender and its nonce, which must be 0;
- the funding for each gas-limit variant (gas limit × 100 gwei);
- the L1 estimate on this chain;
- the variant that covers execution plus twice the L1 gas.

On Nitro the L1 component counts inside the gas limit. A variant that runs out of gas spends the nonce, and the contract
can then never be at its address there, so rehearse on a fork first.

Safe 1.3.0 is permissionless through the Arachnid proxy. Safe 1.4.1 and 1.5.0 need the Safe Singleton Factory, which
only the Safe team deploys, on request. So Elysium's governance is a new Safe 1.3.0 with the production owners, the
owner's decision of 5 Nov 2026 ([GOVERNANCE_SAFE.md](GOVERNANCE_SAFE.md)). The report also bounds Domino's own eleven transactions:
11 × 16,777,216 gas at 3 × the base fee.

## What it cannot verify

- **Which pool prices HYPE.** Elysium has no Chainlink feed, so the profile names a WHYPE/stable pool
  (`gasPrice.poolNativeUsd`). The owner decided this on 5 Nov 2026: a pool's spot, used only while its depth reaches the
  floor, until the HyperCore precompile. The draft proposes the deepest pool; the choice is the owner's.
- **The Universal Router's version.** The schema admits only 2.1.2.
- **The bridge providers.** The draft names none, so S2 starts off there.
- **That the given addresses are Uniswap's official deployment.** It verifies their bytes and wiring, not who deployed
  them.
- **The stable.** It is the owner's choice: its code, symbol and decimals are read.
- **The names.** Slug, name and native symbol come from the placeholder.
- **Enabling the chain.** `deploy.mjs` is frozen. It admits 4663, 8453, 42161 and Elysium's 99901; any other chain
  needs a new release candidate. Enabling also touches the profile tests and the API schemas that list the enabled
  chain ids (`schemaGaps` names them).

## Elysium mainnet (9 Nov 2026)
Kinetiq published chain 99901 on 9 Nov 2026 (docs "Connecting to Elysium" and "Contract addresses"). The run, read-only
through Kinetiq's public RPC (the owner's Alchemy app was not enabled for the network yet), took 72 calls in 11 s at
block 3,233,210:
- **Chain:** ArbOS 61, 0.096 s blocks, `finalized` 350 s behind, base fee 0.1 gwei, Cancun opcodes and
  `eth_simulateV1`.
- **Canonical:** CreateX, Arachnid, Multicall3, Permit2 and Safe 1.3.0. The Safe Singleton Factory is absent, as on the
  testnet.
- **Uniswap v4 only** (the addresses from Ascend's documents, verified by their bytes and wiring): PoolManager
  byte-identical to the three profiles' once its own address is substituted; hookless HYPE/USDC pools at 0.05%, 0.3%
  and 1%.
- **Universal Router:** the one Ascend lists (23,233 B) is not the 2.1.2 build (24,380 B), nor 2.0 (19,499 B). The
  owner chose a copy of Uniswap's own 2.1.2: Arbitrum One's creation code (Uniswap's deployer, tx
  0x42ed46c9b29461557ef12d2588165dffe4909f6f248a3564f904fbe1f1dc78a4) with Elysium's router parameters, created
  through the Arachnid proxy at 0x32ca6537934D333B776283d38834309CAc06b3E7. Simulated there, its runtime is Arbitrum's
  2.1.2 with every PUSH32 operand masked.
The enabled profile (`api-contracts/v2/chains/elysium-99901.json`) replaced the placeholder, which stays as the
backend's test fixture (`backend/tests/fixtures/v2-pending-elysium.json`) for the pending-profile rules and this tool's
tests.

## Rehearsal on the testnet (5 Nov 2026)

`--rpc-env` pointing at `https://testnet-rpc.elysium.kinetiq.xyz`, with `--pending elysium --chain-id 99801` and the
testnet WHYPE, took 45 calls in 7 s. No Uniswap contracts were given: there are no official ones there.

**Chain:**
- ArbOS 61, 0.107 s blocks, `finalized` 712 s behind, base fee 0.1 gwei;
- the L1 component is 1,448 gas for 42 KB;
- Cancun opcodes and `eth_simulateV1` both work.

**Present and canonical:** CreateX, Arachnid, Multicall3, Permit2 (identical to all three profiles' after substitution),
and Safe 1.3.0 (singleton, SafeL2 and proxy factory).

**Absent:** the Safe Singleton Factory, and with it Safe 1.4.1 and 1.5.0.

**Unprotected transactions:** the keyless senders' nonces (1) show that the chain accepted them.

**Governance:** the Safe 1.3.0 with the production owners was planned on the testnet and created on a fork
([GOVERNANCE_SAFE.md](GOVERNANCE_SAFE.md)).
