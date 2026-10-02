/**
 * The public WalletConnect project id, from the owner's free project at cloud.reown.com (2026-10-01, audit C3).
 *
 * Empty until the owner sends it: the Connect dialog then offers no WalletConnect option, and nothing of WalletConnect
 * is ever loaded or contacted. The id is public by design (every site that uses WalletConnect ships its own in its
 * scripts); it names the project to WalletConnect's relay and is no credential. Set it here, in one commit, rather
 * than from the build machine's environment, so that the repository alone decides what a build contains.
 *
 * It must be the 32 lowercase hexadecimal characters Reown's dashboard shows; anything else is treated as no id.
 */
export const WALLETCONNECT_PROJECT_ID = ''
