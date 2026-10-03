# V2 fork rehearsal: Robinhood, Base and Arbitrum

Run on 2 October 2026 at 21:58-22:02 BRT (3 October, 00:58-01:02 UTC), from commit
`24a35eba2b24bab0ee3829fd7c0f886d7350291c` with a clean tree (the reports record `sourceChanges: false` and
`toolChanges: false`). Every transaction went to a fresh loopback Anvil fork that the rehearsal started itself;
the upstream endpoints were only read. **Public transactions sent: 0.**

Each fork deployed the owner's production plan: deployer `0x706627E3E75b0603c4B6f9a1eBBfc635dA712747` with its real
balance (no top-up), the owner's Safe `0x2B1d4098EC880058886B95A0E75069a7099C5a9d` as governance, and the owner's
guardian, fee recipient, operator and publisher. All 13 addresses equal the predicted production addresses on all
three chains ([summary.json](summary.json)). The manifests ([robinhood](robinhood-4663-deployment.json),
[base](base-8453-deployment.json), [arbitrum](arbitrum-42161-deployment.json)) say `environment: fork-rehearsal`, so no
backend admits them for production. The full evidence is in the `*-rehearsal.json` files: the preflight report,
every receipt and the gas of every action.

| Chain | Upstream | Fork block | Block hash |
| --- | --- | ---: | --- |
| Robinhood (4663) | own node, through the existing loopback SSH tunnel | 78,677,944 | `0xdb83463f25ecd4f9ba08ecd45d167eb49511bf42d195860f6fc7df62e7323b6b` |
| Base (8453) | `mainnet.base.org`, read-only; fork in Jovian mode, which charges the L1 fee | 52,099,881 | `0x1b8bfab15e608882289e3248df4f0c1cd4de5b94f465ad698114e1ccd561dafa` |
| Arbitrum (42161) | `arb1.arbitrum.io/rpc`, read-only | 511,152,753 | `0x75fa8ffda675a609c3ba7df277809ac1a541f106a9a150e3de3e804b43b1db1b` |

## Deployment and funding

| | Robinhood | Base | Arbitrum |
| --- | ---: | ---: | ---: |
| Fork block | 78,677,944 | 52,099,881 | 511,152,753 |
| Base fee at the fork block (gwei) | 0.0309 | 0.0050 | 0.0200 |
| Deployer nonce / balance (ETH) | 300 / 0.101101 | 79 / 0.012730 | 500 / 0.043966 |
| Execution gas, simulated offline | 38,919,735 | 38,919,579 | 38,919,795 |
| Execution gas, on the fork | 38,922,336 | 38,922,180 | 38,922,396 |
| L1 (live) | 38,851 gas | 0.000001 ETH | 154,964 gas |
| Sum of gas limits | 48,698,487 | 48,649,478 | 48,845,271 |
| Max fee / tip (gwei) | 0.0810 / 0.0000 | 0.0160 / 0.0010 | 0.0525 / 0.0000 |
| Worst case the preflight required (ETH) | 0.003946 | 0.000777 | 0.002564 |
| Highest max fee the balance covers (gwei) | 2.0761 | 0.2617 | 0.9001 |
| Cost at the chain's price (ETH) | 0.001203 | 0.000234 | 0.000782 |
| Preflight | passed (2 warnings) | passed (2 warnings) | passed (2 warnings) |
| Resume after 5 of 11 | verified, same code | verified, same code | verified, same code |

- **Preflight** (the owner's checks, on the fork): the chain, CreateX, Uniswap v3/v4, Permit2, Universal Router and
  charge currencies by code hash and cross-reference; the owner's Safe (proxy 1.5.0, SafeL2 1.5.0, threshold 2 of 3,
  no module, no guard); the deployer's nonce with nothing pending; empty targets; gas limits; funding. It passed on
  all three with two warnings: two of the Safe's owners are the deployer and the guardian, as the owner chose.
  On each chain's real Safe code, it refused the owner's guardian EOA (`governance_has_no_code`), CreateX
  (`governance_not_a_safe_proxy`) and a 1-of-3 Safe (`governance_threshold_below_two`).
- **Gas limits** are the package's simulated execution plus the live L1 gas, × 125%. On the forks each step used
  100.00% to 100.02% of its own chain's simulated gas (table below), so every limit was 124.98% to 125% of what the
  step used on the fork plus its live L1 gas. The largest, vault.v4, is 11.0M, under EIP-7825's 16.78M cap.
- **Funding:** the deployer's balance covers the worst case on every chain. On the chain's own base fee at the fork
  block (Anvil's falls block after block), the whole deployment costs 0.0012 ETH on Robinhood, 0.00023 ETH on Base and
  0.00078 ETH on Arbitrum, L1 included. On Base, the balance (0.0127 ETH) would cover a max fee up to about 0.26 gwei
  for all eleven limits together; the default was 0.016 gwei.
- **Resume:** from the same block, the deployment was also interrupted after five steps, resumed from the deployer's
  next nonce (`resume` proved the five by code hash, then prepared and preflighted the other six) and verified with
  the mixed receipts: the same 13 runtimes. That chain was then discarded and the straight run above was kept.

## The production preparation, read-only

The same commit then ran the owner's `prepare` against the three real chains (Robinhood through the own node),
read-only, with the owner's `roles.json`: provenance (clean tree, committed profiles), no development EVM, the live
NodeInterface and GasPriceOracle, the owner's Safe and the live balances. Each produced 11 unsigned transactions
and passed the preflight with the same two warnings. Nothing was signed or sent, and the packages are not kept: they
name a pre-merge commit and expire after 24 hours, so the owner prepares again from `main`.

| | Robinhood | Base | Arbitrum |
| --- | ---: | ---: | ---: |
| Block read | 78,680,643 | 52,100,120 | 511,154,640 |
| Client | Nitro v3.11.4 (own node) | reth v2.5.2 | Nitro v3.12.1 |
| Deployer nonce / balance (ETH) | 300 / 0.101101 | 79 / 0.012730 | 500 / 0.043966 |
| Live L1 | 156,825 gas | 0.0000007 ETH | 155,536 gas |
| Default max fee / tip (gwei) | 0.0925 / 0 | 0.016 / 0.001 | 0.0602 / 0 |
| Worst case / highest coverable max fee | 0.0045 ETH / 2.07 gwei | 0.00078 ETH / 0.26 gwei | 0.0029 ETH / 0.90 gwei |
| The 13 targets and their CREATE3 proxies | empty | empty | empty |

## Gas of each deployment transaction

| Component | Simulated (Base) | Robinhood | Base | Arbitrum | Limit (RH / Base / Arb) |
| --- | ---: | ---: | ---: | ---: | --- |
| registry | 1,932,617 | 1,932,821 | 1,932,617 | 1,932,833 | 2,418,407 / 2,415,772 / 2,425,484 |
| priceAnchor | 1,759,277 | 1,759,277 | 1,759,277 | 1,759,277 | 2,201,534 / 2,199,097 / 2,208,769 |
| autoExit | 4,379,642 | 4,379,630 | 4,379,642 | 4,379,642 | 5,480,239 / 5,474,553 / 5,497,174 |
| vaultSwap | 1,685,654 | 1,685,642 | 1,685,654 | 1,685,654 | 2,109,444 / 2,107,068 / 2,116,597 |
| vault.v3 | 7,947,862 | 7,948,100 | 7,948,100 | 7,948,100 | 9,944,404 / 9,934,828 / 9,973,007 |
| vault.v4 | 8,776,156 | 8,777,558 | 8,777,558 | 8,777,558 | 10,980,472 / 10,970,195 / 11,011,612 |
| vaultFactory.v3 | 434,900 | 434,900 | 434,900 | 434,900 | 544,352 / 543,625 / 546,555 |
| vaultFactory.v4 | 435,079 | 435,079 | 435,079 | 435,079 | 544,575 / 543,849 / 546,779 |
| zap.v4.steps | 1,711,256 | 1,711,256 | 1,711,256 | 1,711,256 | 2,141,253 / 2,139,070 / 2,147,864 |
| zap.v3 | 5,191,582 | 5,191,830 | 5,191,842 | 5,191,842 | 6,496,024 / 6,489,478 / 6,515,923 |
| zap.v4 | 4,665,554 | 4,666,243 | 4,666,255 | 4,666,255 | 5,837,783 / 5,831,943 / 5,855,507 |

The executors' gas is part of their vaults' rows.

## The owner's roles

On each fork, after the deployment, with the owner's Safe acting through two impersonated owners (the deployer and
the third owner approve and execute each Safe transaction; no key was used):

- **Governance handoff, both ways:** the Safe proposed the deployer and the deployer accepted; then the deployer
  proposed the Safe and the Safe accepted. Governance ends with the Safe and nothing pending. The production
  deployment needs neither: the Safe is governance from the registry's constructor.
- **Operator and publisher registration:** the Safe scheduled a rehearsal operator and a rehearsal publisher; executing
  before the 24-hour timelock was refused; after it, both were admitted, next to the owner's operator and publisher.
- **Guardian:** the owner's guardian cancelled a fee-recipient change the Safe had scheduled; it later halted
  automation, an operator execution was refused (`AutomationUnavailable`), and only the Safe's resume, scheduled after
  the halt and executed after the timelock, restored it.
- **Fee recipient:** the owner's fee recipient received every fee below.

## Pool creation and journeys

All on the forks' real Uniswap deployments and real tokens:

- **New pools (M1):** the zap created and initialised a hookless v4 ETH/stable pool that did not exist (fee 2345,
  tick spacing 47, at the existing ETH/stable pool's price) and a new v3 pool of WETH and a rehearsal ERC-20
  (fee 3000, price 1), minted a position in each and exited it.
- **Manual management:** zap create and exit on the existing v3 and v4 ETH/stable pools.
- **Vault:** for each DEX, a root minted by the zap, a vault created through its factory (subscribed on v4), a
  compound executed by the owner's operator with a price observation signed by the publisher registered through
  governance: exactly 2% of the consumed earned fees, once, received by the owner's fee recipient.
- **Auto-exit:** an owner-signed take-profit crossed by real swaps and executed by the operator registered through
  governance: 0.2% of the position's value in the best-ranked received currency, received by the fee recipient.
  The zap, the swap module and the exit module kept no tokens.

| Action | Robinhood | Base | Arbitrum |
| --- | ---: | ---: | ---: |
| create-1-of-3-test-safe | 305,835 | 305,835 | 305,835 |
| safe-proposes-deployer-as-governance: owner approves | 52,729 | 52,753 | 52,741 |
| safe-proposes-deployer-as-governance | 106,127 | 106,127 | 106,127 |
| deployer-accepts-governance | 28,030 | 28,030 | 28,030 |
| deployer-proposes-safe-as-governance | 47,909 | 47,909 | 47,909 |
| safe-accepts-governance: owner approves | 52,753 | 52,753 | 52,753 |
| safe-accepts-governance | 68,856 | 68,856 | 68,856 |
| schedule-operator-registration: owner approves | 52,753 | 52,753 | 52,753 |
| schedule-operator-registration | 187,946 | 187,946 | 187,946 |
| schedule-publisher-registration: owner approves | 52,753 | 52,753 | 52,753 |
| schedule-publisher-registration | 187,969 | 187,969 | 187,969 |
| schedule-unwanted-fee-recipient: owner approves | 52,753 | 52,753 | 52,753 |
| schedule-unwanted-fee-recipient | 165,080 | 165,080 | 165,080 |
| guardian-cancels-scheduled-change | 38,327 | 38,327 | 38,327 |
| execute-before-timelock-refused: owner approves | 52,741 | 52,753 | 52,753 |
| execute-before-timelock-refused | 75,362† | 75,362† | 75,362† |
| execute-operator-registration: owner approves | 32,841 | 32,853 | 32,853 |
| execute-operator-registration | 97,148 | 97,148 | 97,148 |
| execute-publisher-registration: owner approves | 52,753 | 52,753 | 52,753 |
| execute-publisher-registration | 97,170 | 97,170 | 97,170 |
| fund-user-stable-from-holder | 65,378 | 62,171 | 62,171 |
| wrap-user-eth | 57,647 | 44,866 | 57,975 |
| v4-create-new-pool-and-position-approve | 57,976 | 55,437 | 55,437 |
| v4-create-new-pool-and-position | 456,316 | 449,006 | 449,006 |
| v4-exit-new-pool-position-approve | 48,300 | 48,300 | 48,300 |
| v4-exit-new-pool-position | 182,463 | 179,268 | 179,268 |
| deploy-rehearsal-token | 361,421 | 361,421 | 361,421 |
| v3-create-new-pool-and-position-approve | 53,425, 46,152 | 46,031, 46,152 | 46,152, 53,440 |
| v3-create-new-pool-and-position | 5,272,665 | 5,255,311 | 5,273,432 |
| v3-exit-new-pool-position-approve | 53,838 | 53,838 | 53,838 |
| v3-exit-new-pool-position | 260,908 | 258,345 | 264,677 |
| v3-zap-create-approve | 53,425, 57,988 | 46,031, 55,449 | 53,440, 55,449 |
| v3-zap-create | 630,449 | 553,458 | 572,723 |
| v3-zap-exit-approve | 53,838 | 53,838 | 53,838 |
| v3-zap-exit | 276,820 | 253,728 | 260,060 |
| v3-zap-create-root-approve | 53,425, 57,988 | 46,031, 55,449 | 53,440, 55,449 |
| v3-zap-create-root | 621,270 | 513,658 | 532,923 |
| v3-approve-predicted-vault | 53,838 | 53,838 | 53,838 |
| v3-vault-create | 391,439 | 391,439 | 391,439 |
| guardian-halts-automation | 34,644 | 34,644 | 34,644 |
| operator-execution-while-halted | 39,215† | 39,215† | 39,215† |
| schedule-resume-automation: owner approves | 52,753 | 52,753 | 52,753 |
| schedule-resume-automation | 121,838 | 121,838 | 121,838 |
| execute-resume-automation: owner approves | 52,753 | 52,753 | 52,753 |
| execute-resume-automation | 79,773 | 79,773 | 79,773 |
| v3-enable-auto-exit | 53,751 | 53,751 | 53,751 |
| v3-register-mandate | 162,307 | 162,319 | 162,307 |
| v3-approve-swap | 57,976 | 55,437 | 55,437 |
| v3-swap-stable-in | 137,333 | 117,991 | 125,876 |
| v3-approve-reverse | 53,413 | 46,019 | 53,428 |
| v3-swap-eth-in | 128,633 | 114,445 | 125,789 |
| v3-vault-compound-signed-observation | 604,559 | 511,673 | 532,297 |
| v3-auto-exit-trigger | 430,704 | 402,795 | 416,041 |
| v4-zap-create-approve | 57,988 | 55,449 | 55,449 |
| v4-zap-create | 387,440 | 357,673 | 357,673 |
| v4-zap-exit-approve | 48,300 | 48,300 | 48,300 |
| v4-zap-exit | 196,038 | 191,987 | 191,987 |
| v4-zap-create-root-approve | 57,988 | 55,449 | 55,449 |
| v4-zap-create-root | 387,440 | 357,673 | 357,673 |
| v4-approve-predicted-vault | 48,300 | 48,300 | 48,300 |
| v4-vault-create | 383,403 | 383,403 | 383,403 |
| v4-enable-auto-exit | 53,751 | 53,751 | 53,751 |
| v4-register-mandate | 162,353 | 162,353 | 162,353 |
| v4-approve-permit2 | 57,916 | 55,377 | 55,377 |
| v4-permit2-router | 47,578 | 47,590 | 47,590 |
| v4-swap-stable-in | 133,492 | 130,372 | 130,344 |
| v4-swap-eth-in | 117,757 | 114,602 | 114,574 |
| v4-vault-compound-signed-observation | 458,411 | 457,236 | 476,698 |
| v4-auto-exit-trigger | 372,175 | 358,192 | 358,192 |

† reverted, as expected.

## What was synthetic

- Impersonation of the deployer, the Safe's owners, the guardian and the owner's operator: no owner key was used.
- The rehearsal accounts (`keccak256("domino.v2.rehearsal.<label>")` keys): the user, a second operator and publisher,
  the token deployer and a 1-of-3 test Safe.
- Stable funding from an on-fork holder (each chain's v4 PoolManager), ETH for the rehearsal user, and time jumps for
  the timelocks.
- Gas money for accounts that held too little for the rehearsal's own actions, never for the deployment
  (`syntheticGasOnFork` in each report): the owner's operator `0x64b7…098a` on all three chains, the rehearsal
  operator on all three, the owner's guardian `0x5e57…D103` on Robinhood, and the Safe's third owner `0x19eA…a792`
  on Base (it held 0.000038 ETH).

The owner's operator holds no ETH on any of the three chains and the guardian none on Robinhood: they need gas
before the service runs and before any emergency action. The publisher only signs and needs none.

## Reproduce

```sh
npm ci && npm --prefix app ci
node scripts/v2/deploy-fork.mjs --robinhood-rpc http://127.0.0.1:18551 \
  --base-rpc https://mainnet.base.org --arbitrum-rpc https://arb1.arbitrum.io/rpc --out <empty directory>
```

Robinhood is read only through the own node's loopback tunnel (the harness refuses any other host for it); the
tunnel is not opened or closed by the rehearsal. The Anvil forks keep their history in memory (no state directory)
and use no RPC cache. Elysium is out of scope until its mainnet has CreateX.
