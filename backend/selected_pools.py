"""The pools the landing reads, as the backend's registration manifest.

Ids only. This is not a token allowlist, not an execution admission and not a
ranking: every read still proves identity, manager, pool key, block and
provider again. `app/src/config/selectedPools.ts` holds the same ordered ids for
the frontend, and a test fails when the two lists differ, so seeding and
registration cannot silently follow a list the product no longer shows.
"""

SELECTED_POOLS = (
    '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6',
    '0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7',
    '0x94c62eebf6454231b2fcd0259ede448ae3c6ad8617718cd88dab20b30cfae48a',
    '0xf399bd1544377680d48c62fd85c2105b869e55906c4189cc5ab3b4e83446928c',
    '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e',
    '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a',
)
