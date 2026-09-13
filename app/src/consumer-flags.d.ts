/**
 * Build-time constants from vite.config.ts for the onboarding previews (#38)
 * and the deposit consumer's fixture lab (#40/#44). Both are true only in the
 * `consumer-test` build and are replaced by literals, so the screens behind
 * them, their validators, fixtures and copy are removed from every other
 * build, including the one that deploys.
 */
declare const __DOMINO_ONBOARDING_PREVIEW__: boolean
declare const __DOMINO_DEPOSIT_LAB__: boolean
