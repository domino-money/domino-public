"""Recompute audit-table quantities from committed raw records, without RPC."""
import json
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 80
ROOT = Path(__file__).resolve().parents[3]
Q192 = Decimal(2) ** 192
for stem in ("narrow", "wide"):
    data = json.loads((ROOT / f"reports/fork/weth-usdg-{stem}-2026-09-20.json").read_text())
    reference = Decimal(data["referenceSqrtPrice"])
    honest, swap_honest = data["scenarios"][:2]
    baseline_delta = int(swap_honest["vaultValueAfterQuote"]) - int(honest["vaultValueAfterQuote"])
    assert baseline_delta != 0
    print(json.dumps({"range": stem, "swapHonestMinusGeneralHonestUSDG": str(Decimal(baseline_delta) / 10**6)}))
    for scenario in data["scenarios"]:
        if scenario["scenario"] != "swap-post-observation" or scenario["outcome"] != "executed":
            continue
        anchor = Decimal(scenario["anchorSqrtPrice"])
        execution = Decimal(scenario["sqrtPriceAtCompound"])
        sold = Decimal(scenario["swapIn0"])
        anchor_shortfall = sold * (reference**2 - anchor**2) / Q192 / 10**6
        execution_shortfall = sold * (reference**2 - execution**2) / Q192 / 10**6
        assert anchor_shortfall == 0
        assert execution_shortfall > 0
        print(json.dumps({"range": stem, "moveBps": scenario["moveBps"],
            "anchorQuoteShortfallUSDG": str(anchor_shortfall),
            "preSwapSpotQuoteShortfallUSDG": str(execution_shortfall),
            "actualOutputRecorded": "amountOut" in scenario}))
