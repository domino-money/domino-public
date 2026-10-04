# V2 on Robinhood, Base and Arbitrum: 4 October 2026

**What.** The owner deployed release `v2-release-2026-10-04` on the three chains:
- The tag object is `c703b1a6…`. It points to commit `559c509ff71d71e49ac720bd6acd8a9783531ebb`, the commit of `v2-audit-2026-10-04.2`.
- The deployer `0x7066…2747` sent 11 transactions on each chain, through CreateX.
- Each chain's `deployment.json` is the output of `deploy.mjs verify` at a `finalized` block, and `deploy.mjs validate` accepts it.
- The 39 contracts (13 on each chain) have verified sources on Sourcify.

**Addresses.** The 13 addresses are the same on the three chains, and the same as in the rehearsals of 2 and 4 October. CREATE3 addresses depend only on the deployer and the salts. `vaultExecutor.v3` and `vaultExecutor.v4` are created by their vaults' constructors.

| Component | Address |
| --- | --- |
| registry | `0x25d4f013ecff3790e384e16ca9951bba6cd715fa` |
| priceAnchor | `0x8c1edc4280d9533f6336f760380ba329e1f81f43` |
| autoExit | `0x6109fc514a88a8e85e6e5c863238ddba9a98be36` |
| vaultSwap | `0xbf22a36bbb419846e073cf0c6c729f669d7f348a` |
| vault.v3 | `0xd55c0f5ff8ad1ded828edb36be77e0f3677ad4a4` |
| vault.v4 | `0xa3ff8d74e4ec4a19f35d92b7eec852ba6f7e2bbb` |
| vaultFactory.v3 | `0xa7dfb61a6597d09742cb7f9a8780c9c74ebc34f4` |
| vaultFactory.v4 | `0xc71a561853514efc2271f1d10c13ec95834792ba` |
| zap.v4.steps | `0x355b0997d5e04392862a8e8d21d911851b2eefbe` |
| zap.v3 | `0xe30d7e07a67198c45d4c7b67d8423cbb6c7ea5a0` |
| zap.v4 | `0x376b92929bbe778c6dd64e8d73f8688686288e8a` |
| vaultExecutor.v3 | `0xd8d3bf832b234855fee2ac36ac4803aa7f9adca9` |
| vaultExecutor.v4 | `0xf3f68d8461c2071e2b8d88a60ce64f527f1d6639` |

**Roles**, the same on the three chains:

| Role | Address |
| --- | --- |
| Governance (Safe 1.5.0, 2-of-3) | `0x2b1d4098ec880058886b95a0e75069a7099c5a9d` |
| Guardian | `0x5e57fded90c4635648eb7b3ba29705ff0769d103` |
| Fee recipient | `0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4` |
| Operator | `0x64b72517d8b0d72be25f814b4e03985cf15e098a` |
| Publisher | `0x07c7e7f92e2c76c9cb8d7f2ae44caa6877fc7df3` |
| Deployer | `0x706627e3e75b0603c4b6f9a1ebbfc635da712747` |

## The three deployments

| | Robinhood (4663) | Base (8453) | Arbitrum (42161) |
| --- | ---: | ---: | ---: |
| Preflight passed (UTC) | 19:36:39 | 19:41:30 | 19:46:21 |
| Transactions (UTC) | 19:36:54–19:40:13 | 19:42:43–19:59:35 | 19:46:49–19:50:02 |
| Blocks | 80,189,516–80,191,491 | 52,176,808–52,177,314 | 511,706,605–511,707,289 |
| Deployer nonces | 300–310 | 79–89 | 500–510 |
| Gas used | 39,808,515 | 39,496,198 | 39,737,704 |
| Cost (ETH) | 0.000801 | 0.000249 | 0.000796 |
| Rehearsal estimate at the chain's price (ETH) | 0.000816 | 0.000239 | 0.000795 |
| Verified at finalized block | 80,195,475 | 52,177,509 | 511,707,510 |
| Sourcify | 13/13 | 13/13 | 13/13 |

**Costs.**
- The three chains cost 0.001846 ETH in total.
- Base's cost includes its L1 data fee of 0.000001 ETH.
- On Robinhood and Arbitrum (Nitro), the L1 component is part of the gas used. That is the difference from the fork rehearsal's 39.50M, which had no L1 component.

**Base's window.** Base took 17 minutes because the page stopped after Base's first step (see below), until it was corrected.

## How it was sent

1. **Packages.** `deploy.mjs prepare`, run from the tag's clean checkout, wrote one unsigned package per chain. They are in `unsigned-package.json`, and their digests are `b85b8023…`, `983801d0…` and `5c2c8b12…`.
2. **Preflight.** Each chain's preflight passed within two minutes before its first transaction. These are the `preflight.json` files. They carry the two expected warnings: two of the Safe's owners are the deployer and the guardian.
3. **Signing and sending.** The owner's wallet signed and sent each transaction. The key never left the wallet. A local page, which is not in this repository, built each request from the package: the step's exact `to`, `data` and gas limit, one step at a time. After each receipt, the page checked the runtime hash at the step's address.
4. **No transaction was resent.** Each chain has exactly eleven transactions from the deployer. They are at consecutive nonces, and all succeeded. `transactions.json` maps each component to its transaction.

**The page reported steps as failed that had succeeded.** Right after a receipt, the page reported a step as failed three times:
- `zap.v3` on Robinhood;
- `registry` on Base, which then showed "CREATE3 proxy spent but no component";
- one step on Arbitrum.

**Cause.** The page read the code at `latest` through the wallet's RPC. That RPC spreads calls over several nodes, and the read came from a node one block behind. The transactions themselves were fine: every receipt succeeded and every runtime was correct.

**Fix in the page.**
- The page now reads state at a block no older than the receipt it checks. A node that does not have that block answers with an error and is asked again.
- A step the page sent is judged by its own transaction.

It was checked on forks with a simulated node one block behind: the old reads failed at every step, and the new ones deployed eleven of eleven.

**Base's preflight refused after step 1.** It returned `deployer_nonce_mismatch`. This is by design: a package's preflight checks its first nonce.

## Source verification

| | Robinhood | Base | Arbitrum |
|---|---|---|---|
| Sourcify result | 13/13 `match` | 13/13 `match` | 13/13 `match` |
| Etherscan family | 13/13 on `robin.etherscan.io` | 13/13 on Basescan | 13/13 on Arbiscan |
| Blockscout | not imported yet | not checked | not checked |

**The input.** It is the output of `deploy.mjs explorer-input`:
- the build's exact standard-JSON input (solc 0.8.26, via-IR, 200 runs, cancun);
- each contract's fully qualified name;
- each contract's constructor arguments.

`sourcify.json` records each contract's Sourcify result and the input's SHA-256. `etherscan.json` records each contract's Etherscan result, the name and compiler the explorer shows, and its page.

**Why `match` and not `exact_match`.** The release compiles with `metadata.bytecodeHash: none`, so there is no metadata hash in the bytecode. `match` means the runtime bytecode is equal, immutables included. It is the strongest result Sourcify can give this build.

**The explorers.**
- **Blockscout.** The Robinhood Blockscout has not imported the Sourcify verification. Its API refuses scripted requests, and its form takes the same standard-JSON input as a file upload.
- **The Etherscan family** (Robin Etherscan for Robinhood, Basescan, Arbiscan) was verified on 4 Oct, 20:49–21:22 UTC.
  - It went through the Etherscan API V2, with the owner's key.
  - The input is the same as Sourcify's, with the MIT license of the sources.
  - On each chain, `vaultFactory.v4` came out "already verified": the explorer matched it to `vaultFactory.v3`, which has the same contract and runtime code.

## Files

Each chain's folder holds:

| File | Content |
| --- | --- |
| `deployment.json` | The verified manifest |
| `unsigned-package.json` | The package the owner signed from |
| `preflight.json` | The report that passed before the first transaction |
| `transactions.json` | The verification's input |
| `sourcify.json` | The Sourcify verification |
| `etherscan.json` | The Etherscan family's verification |

`summary.json` in this folder gathers the table above.

## Reproduce the verification

From a clean checkout of the tag, with dependencies from the lockfiles:

```sh
npm ci && npm --prefix app ci
node scripts/v2/deploy.mjs verify --package docs/deployments/v2-<chain>-2026-10-04/unsigned-package.json \
  --receipts docs/deployments/v2-<chain>-2026-10-04/transactions.json --rpc <url> --out <new file>
node scripts/v2/deploy.mjs validate --manifest <new file>
```

`verify` reads at `finalized` by default. Robinhood's manifest was verified through the own node.

## Next

**The guardian holds no ETH on Robinhood.** It still held none at 20:26 UTC, and it needs gas there before any emergency action.

**Not done yet:**
1. The backend: the V2 operator and publisher keys on the VM, and the planner's gas priors.
2. A hosted RPC for Base and Arbitrum.
3. The app's V2 pages.
4. The automation gaps.
5. The V1 transition.
