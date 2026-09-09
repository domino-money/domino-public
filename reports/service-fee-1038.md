# Reported $10.38 service fee — 9 September 2026

The private practice app's Activity view showed a $518.94 available-fee balance, $10.38 service fee, $508.56 reinvestment and no remaining fees at 11:03:58. Its preceding receipt for the same position showed $500 available, $150 reinvested, $3.06 service fee and $346.94 remaining at 10:42:57. These are rounded on-screen amounts, not blockchain transactions.

The displayed arithmetic matches the proposed 2% rate: the previously unused balance plus approximately $172 of newly added hypothetical fees became the current charge base. The earlier service fee applied only to the consumed portion; remaining fees had not yet been charged. No duplicate service charge was found in this sequence.

An exact regression scenario with the historical $1,000-position limit reproduces the display: $346.938776 waiting + $172 new = $518.938776 available; service cut $10.378775; reinvested $508.560001. Across both scenarios, $672 of introduced fees equals $658.560001 reinvested plus $13.439999 service charges, with no residual. A zero-new-fees recheck of the earlier balance would instead produce a $6.938775 service fee.

The interface was ambiguous about adding new fees versus reusing the waiting balance. The field now defaults to zero, explicitly adds newly earned hypothetical fees, and is described as an addition rather than a reinvestment limit. Previews and Activity show the prior/new split and the actual 2% charge base. New receipts record both funding components; older records derive them only if the previous balance is available. Historical records are not rewritten or deleted.

Validation: 17 domain tests passed, including the reported arithmetic, zero-new-fees alternative, provenance reconstruction, missing-history behavior and malformed funding. TypeScript and application lint passed. No personal-bot or wallet action was performed.
