# V2 on Elysium: 9 November 2026

**What.** The owner deployed release `v2-release-2026-11-09` on Elysium mainnet (chain 99901), on the day Kinetiq
published it:
- The tag object is `99f81ef2…`. It points to commit `7ba39a5f40110767f7743942b309b445a9b35c88` (#484, Elysium's
  enabled profile), on which main's own CI and Position journeys passed. The V2 contracts and
  `contracts/release-artifacts-v2.json` (`aae7032b…b510`) are those of `v2-release-2026-10-04`.
- Elysium has Uniswap v4 only, so the deployment has 9 contracts, not 13: the deployer `0x7066…2747` sent 8
  transactions through CreateX (nonces 2 to 9), and `vault.v4`'s constructor creates `vaultExecutor.v4`.
- `deployment.json` is the output of `deploy.mjs verify` at a `finalized` block, and `deploy.mjs validate` accepts it.
  `preflight.json` is the preflight the deploy page ran right before the first step; `unsigned-package.json` is the
  package it sent; `transactions.json` maps each component to its transaction.

**Addresses.** The same as on Robinhood, Base and Arbitrum: CREATE3 addresses depend only on the deployer and the salts.

| Component | Address |
| --- | --- |
| registry | `0x25d4f013ecff3790e384e16ca9951bba6cd715fa` |
| priceAnchor | `0x8c1edc4280d9533f6336f760380ba329e1f81f43` |
| autoExit | `0x6109fc514a88a8e85e6e5c863238ddba9a98be36` |
| vaultSwap | `0xbf22a36bbb419846e073cf0c6c729f669d7f348a` |
| vault.v4 | `0xa3ff8d74e4ec4a19f35d92b7eec852ba6f7e2bbb` |
| vaultFactory.v4 | `0xc71a561853514efc2271f1d10c13ec95834792ba` |
| zap.v4.steps | `0x355b0997d5e04392862a8e8d21d911851b2eefbe` |
| zap.v4 | `0x376b92929bbe778c6dd64e8d73f8688686288e8a` |
| vaultExecutor.v4 | `0xf3f68d8461c2071e2b8d88a60ce64f527f1d6639` |

**Roles.** The production roles, except governance (the owner's decision of 5 Nov 2026, docs/v2/GOVERNANCE_SAFE.md):

| Role | Address |
| --- | --- |
| Governance (Safe 1.3.0 L2, 2-of-3, the production Safe's three owners) | `0xc43944bd6e7f0c79909878ab1c04241ad210ecc3` |
| Guardian | `0x5e57fded90c4635648eb7b3ba29705ff0769d103` |
| Fee recipient | `0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4` |
| Operator | `0x64b72517d8b0d72be25f814b4e03985cf15e098a` |
| Publisher | `0x07c7e7f92e2c76c9cb8d7f2ae44caa6877fc7df3` |
| Deployer | `0x706627e3e75b0603c4b6f9a1ebbfc635da712747` |

## Before the deployment

The owner sent both from the deployer. Neither needs a role: anyone may send them, and each lands at an address fixed
by its inputs.

| What | Transaction | Block | Gas |
| --- | --- | ---: | ---: |
| Universal Router 2.1.2 at `0x32ca6537934d333b776283d38834309cac06b3e7`: Domino's CREATE2 copy of Uniswap's own 2.1.2 build (Arbitrum One's creation code with Elysium's parameters, through the Arachnid proxy; the profile records its runtime hash) | `0xee2ead4dbae25ea8648c8db350a19fe6e0cf03fa80801eaafeafa55be514dc7e` | 3,263,934 | 5,322,727 |
| Governance Safe 1.3.0 at `0xc43944bd6e7f0c79909878ab1c04241ad210ecc3`; `governance-safe.mjs check` passed at this block, with no warning | `0x8091ade0694d7d98407acc182d0e1ce69b0e5639fb8723e865be4ffe95c7475c` | 3,264,487 | 305,520 |

## The deployment

| Step | Component | Transaction | Block | Gas |
| ---: | --- | --- | ---: | ---: |
| 1 | registry | `0x85f8347ffaa5c3223a5ab4a3569d44988af0787a48e596b9ed3fada57badf628` | 3,318,768 | 1,932,845 |
| 2 | priceAnchor | `0xccfc8cbbe8ce30484ca8406a5a40cebcc57cb6119ff35982c6fdbe00eb2ab9c7` | 3,319,004 | 1,756,071 |
| 3 | autoExit | `0xdf6813d568cd44b61d73b5f8e03f9a127481e3770b0412e12ffa4de3ef202a98` | 3,319,359 | 4,475,992 |
| 4 | vaultSwap | `0xd442151ea515886a470d7dafeb3db3e6b565d87a69fda85673bc821f63d57701` | 3,319,587 | 1,772,617 |
| 5 | vault.v4 | `0xb188a1d309d5c762bcf0473abadc15fd2baebc401f6b333320fd3f760899ed20` | 3,319,840 | 8,835,673 |
| 6 | vaultFactory.v4 | `0x9bd9b90843c1125a328ce7a02a549dbe7ec1cf9e8f3f38ba25bcf501ac9441fd` | 3,320,066 | 435,057 |
| 7 | zap.v4.steps | `0x050e8d523df43bfd0b8ee8a5cfb47e0aaa20193c1fbe964039af907df4efe119` | 3,320,293 | 1,711,256 |
| 8 | zap.v4 | `0x51e5b4fba8a196ae6a74b0ea5a3feb761b427d7a990148c17e1d5ef60a6439b6` | 3,320,634 | 4,792,208 |

Every transaction succeeded on its first send, between 15:27 and 15:30 UTC: 25,711,719 gas, 0.002578 HYPE. The router
and the Safe cost another 0.000563 HYPE.

## Not yet

- **Source verification.** Sourcify does not list chain 99901 (checked 9 Nov 2026), and Elysium's explorer API needs a
  partner key. `deploy.mjs explorer-input` gives the exact standard-JSON input for when one of them takes it.
- **Services and the app.** read-v6 does not name 99901 yet, and no indexer, reader, plan listener or automation runs
  for Elysium. The app's Elysium switch stays off until this record is pinned and read-v6 names the chain
  (app/docs/ELYSIUM_DAY9.md has the publishing order).
