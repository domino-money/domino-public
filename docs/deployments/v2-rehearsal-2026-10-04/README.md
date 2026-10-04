# V2 fork rehearsal of the tagged release: Robinhood, Base and Arbitrum

**When and from where.** Run on 4 October 2026, 19:11–19:14 UTC, from `559c509ff71d71e49ac720bd6acd8a9783531ebb`, the commit of `v2-audit-2026-10-04.2`, with a clean tree. Dependencies came from the lockfiles (`npm ci`). The reports record:
- `sourceChanges: false` and `toolChanges: false`;
- source tree `7a78b034…`, the release manifest's.

**What it does.** Every transaction went to a fresh loopback Anvil fork that the rehearsal started itself. The upstream endpoints were only read. **Public transactions sent: 0.**

**What changed since [2 October](../v2-rehearsal-2026-10-02/README.md).** That rehearsal ran the code from before #317, #319 and #323. This one deploys the frozen release, with the same tool, the same roles and the deployer's real balances:
- **Addresses:** the 13 addresses are the same as on 2 October and identical on all three chains ([summary.json](summary.json)). CREATE3 addresses depend on the deployer and the salts only.
- **Gas:** the deployment takes 0.57M more than then. Four contracts carry the larger swap executor (#323), and #317 and #319 added checks.

| Chain | Upstream | Fork block | Base fee (gwei) |
| --- | --- | ---: | ---: |
| Robinhood (4663) | own node, through the loopback SSH tunnel | 80,174,253 | 0.0206 |
| Base (8453) | `mainnet.base.org`, read-only | 52,175,867 | 0.0050 |
| Arbitrum (42161) | `arb1.arbitrum.io/rpc`, read-only | 511,699,376 | 0.0200 |

## Deployment and funding

| | Robinhood | Base | Arbitrum |
| --- | ---: | ---: | ---: |
| Execution gas, simulated offline | 39,493,753 | 39,493,597 | 39,493,813 |
| Execution gas, on the fork | 39,496,354 | 39,496,198 | 39,496,414 |
| Sum of gas limits | 49,367,196 | 49,367,001 | 49,694,084 |
| Deployer nonce / balance (ETH) | 300 / 0.101101 | 79 / 0.012730 | 500 / 0.043966 |
| Default max fee (gwei) | 0.0542 | 0.0160 | 0.0525 |
| Worst case the preflight required (ETH) | 0.002676 | 0.000790 | 0.002609 |
| Highest max fee the balance covers (gwei) | 2.05 | 0.26 | 0.88 |
| Cost at the chain's price (ETH) | 0.000816 | 0.000239 | 0.000795 |
| Preflight | passed (2 warnings) | passed (2 warnings) | passed (2 warnings) |
| Resume after an interruption | verified | verified | verified |
| Owner roles and journeys | passed | passed | passed |

**The preflight's two warnings** are the owner's choice: two of the Safe's owners are the deployer and the guardian.

**The rest of the run** is the 2 October one, in full:
- the governance handoff both ways;
- operator and publisher registration through the 24-hour timelock;
- the guardian's veto, halt and the timelocked resume;
- zap create and exit on v3 and v4, and new v3 and v4 pools;
- a vault compound with a signed observation;
- an auto-exit.

The per-chain reports hold every receipt and the gas of every action.

**Gas the rehearsal had to give on the forks** (`syntheticGasOnFork`), never for the deployment itself:
- the owner's guardian `0x5e57…D103` holds no ETH on Robinhood, and needs gas there before any emergency action;
- a rehearsal account that triggers the auto-exit;
- the Safe's third owner on Base, which holds 0.000038 ETH.

## Reproduce

```sh
npm ci && npm --prefix app ci
node scripts/v2/deploy-fork.mjs --robinhood-rpc http://127.0.0.1:18547 \
  --base-rpc https://mainnet.base.org --arbitrum-rpc https://arb1.arbitrum.io/rpc --out <empty directory>
```

Robinhood is read only through the own node's loopback tunnel; the harness refuses any other host for it.
