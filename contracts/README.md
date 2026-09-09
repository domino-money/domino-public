# Public contract boundary — draft

`IDominoVaultDraft.sol` specifies the first integration surface for review. It has no implementation and cannot be activated for users. Owner-only policy/escape checks, operator authorization, pool registration, liquidity invariants, actual fee realization, callback security, replay protection and price enforcement are still required in a public vault implementation.

`FeeAccounting.sol` implements only the proposed per-currency fee split for a no-swap path: gross used = net added + protocol cut, with unconsumed balances uncharged. The maximum service cut is 200 bps (2%). The public design removes the inherited 1500 bps liquidity-growth cap in favor of proven fee balances, exact execution budgets and price limits, all of which still need an on-chain implementation. Unit/fuzz tests check arithmetic and rejection boundaries, not public-vault safety. Bounded fee-balancing swaps require a separate typed interface, accounting extension and review under the [reinvestment policy](../REINVESTMENT_POLICY.md); none is implemented here.

The [functional alpha scope](../ALPHA_SCOPE.md) now requires Domino successor creation/funding alongside self-compound. This interface still lacks those typed plans and their fee-balancing swap/accounting implementation; adding them and passing their separate evidence gates is required before alpha activation.

The approved [onboarding scope](../ONBOARDING_AND_POOL_DISCOVERY.md) also needs owner-funded balancing swaps, position creation, advanced bounded pool initialization plus first mint, and native-ETH accounting/refunds. These setup authorities must remain separate from fee-only operator actions. This package implements none of those integrations; a wallet-discovered token or a newly initialized pool does not bypass compatibility checks.

[PRICING_POLICY.md](../PRICING_POLICY.md) proposes a separately capped, owner-reviewed assisted-swap service fee during setup/manual management. The existing 2% earned-fee library does not implement that collection; do not reuse it to charge deposits or add another service charge to automated internal swaps. The setup path requires its own exact-input accounting, fee consent, recipient and recovery tests.

The existing personal contracts, manifests, configuration and deployment are not part of this package. The public design must undergo the independent review described in [SECURITY_SPEC.md](../SECURITY_SPEC.md) before handling assets.

From the repository root, run `npm ci` once, then `npm run test:contracts`. Forge, Anvil and solc are pinned in the root lockfile; this isolated project needs no global Solidity compiler.
