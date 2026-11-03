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

Replaced again on 2 Nov 2026 (the owner, from the featured runs of 24 Oct to
2 Nov): health withdrew USDG/ORBIO (depth under the US$ 10k floor) and
USDG/UBIK (no volume) within hours of each fill, and ETH/USDG 0.05% is now the
deepest ETH/USDG pool, so it is the one major pair in place of 0.01%. The
policy's `ethUsdPricePool` stays the 0.01% pool: it only prices ETH for depth.
"""

SELECTED_POOLS = (
    '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982',  # ETH/USDG 0.05%
    '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a',  # PONS/USDG
    '0x1649550af1e3363b4c25236434530af7e6886b183e1f574a98fdd1d04d287a2d',  # ETH/TORCH
    '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b',  # CASHCAT/USDG
    '0x9be7ab27227e115085b0949a819a73f6963ddc6da0c6204d37757c24297706e8',  # USDG/PRIORS
    '0xa95732060867f07aa9b8ae9a4b7b8d737bc3374f1dfbb952759c5ed676e8737c',  # USDG/VIRTUAL
)
