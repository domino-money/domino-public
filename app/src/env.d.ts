/**
 * Build-time constants from vite.config.ts. Both are true only in the
 * `wallet-test` build and are replaced by literals, so code behind them is
 * removed from every other build.
 */
declare const __DOMINO_WALLET_SESSION__: boolean
declare const __DOMINO_TEST_HOOKS__: boolean
