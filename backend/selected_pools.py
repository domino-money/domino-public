"""The pools the landing reads, as the backend's registration manifest.

Ids only. This is not a token allowlist, not an execution admission and not a
ranking: every read still proves identity, manager, pool key, block and
provider again. `app/src/config/selectedPools.ts` holds the same ordered ids for
the frontend, and a test fails when the two lists differ, so seeding and
registration cannot silently follow a list the product no longer shows.

Replaced on 4 Oct 2026 (the owner, with 0xdecimal's review of the stuck Top
pools): MARLIN was empty, cbBTC is a protected symbol, U an unreviewed
upgradeable token, and WETH/USDG a second major pair beside ETH/USDG. Every
pool below had real reference depth (US$ 22k to 157k) that day.
"""

SELECTED_POOLS = (
    '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e',  # ETH/USDG 0.01%
    '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a',  # PONS/USDG
    '0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef',  # USDG/ORBIO
    '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b',  # CASHCAT/USDG
    '0x6d56f66e52e63e8be558d708a987426314bb4de92bc9b43a44effee1f2abf317',  # USDG/UBIK
    '0xa95732060867f07aa9b8ae9a4b7b8d737bc3374f1dfbb952759c5ed676e8737c',  # USDG/VIRTUAL
)
