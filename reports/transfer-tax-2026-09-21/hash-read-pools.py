#!/usr/bin/env python3
"""Read-only, bounded Hashcats pool qualification through the owner's node.

Run with backend/.venv/bin/python. No keys, signing, configuration files or writes
to a chain. Every RPC is serial and starts at least 0.3 seconds after the prior
one completed. The candidate collection comes from the project's public site.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.request
from datetime import datetime, timezone

from eth_abi import encode, decode
from eth_hash.auto import keccak

OUT = Path(__file__).resolve().parent
TOKEN = "0xca75082b85bb7bec8325d513f615b16bda260020"
COLLECTION = "0xca75df55cc9c476db27a7375d1fc8e794cf80721"
ALLOWED = {"eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode", "eth_getLogs", "eth_getTransactionReceipt"}
REMOTE = '''import sys,json,urllib.request
p=json.load(sys.stdin)
assert p['method'] in {'eth_chainId','eth_getBlockByNumber','eth_call','eth_getCode','eth_getLogs','eth_getTransactionReceipt'}
if p['method']=='eth_getLogs':
 assert int(p['params'][0]['toBlock'],16)-int(p['params'][0]['fromBlock'],16)<20000
r=urllib.request.Request('http://127.0.0.1:8547',data=json.dumps(p).encode(),headers={'Content-Type':'application/json'})
print(urllib.request.urlopen(r,timeout=30).read().decode())'''
records = []


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def rpc(method, params):
    assert method in ALLOWED
    if method == "eth_getLogs":
        assert int(params[0]["toBlock"], 16) - int(params[0]["fromBlock"], 16) < 20000
    time.sleep(0.3)
    payload = {"jsonrpc": "2.0", "id": len(records) + 1, "method": method, "params": params}
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "domino-host",
                        "python3 -c " + __import__("shlex").quote(REMOTE)], input=json.dumps(payload),
                       text=True, capture_output=True, check=True, timeout=45)
    response = json.loads(p.stdout)
    records.append({"atUTC": now(), "request": payload, "response": response})
    if "error" in response:
        raise RuntimeError(response["error"])
    return response["result"]


def call(address, signature, types, args=(), argtypes=()):
    data = "0x" + (keccak(signature.encode())[:4] + encode(argtypes, args)).hex()
    raw = rpc("eth_call", [{"to": address, "data": data}, PIN])
    value = decode(types, bytes.fromhex(raw[2:]))
    return value[0] if len(value) == 1 else list(value)


def source(address):
    url = f"https://sourcify.dev/server/v2/contract/4663/{address}?fields=all"
    data = urllib.request.urlopen(urllib.request.Request(url, headers={
        "User-Agent": "Domino read-only Hashcats pool qualification"}), timeout=40).read()
    path = OUT / "hash-hook-source.json"
    path.write_bytes(data)
    return json.loads(data), {"url": url, "file": path.name, "sha256": hashlib.sha256(data).hexdigest()}


report = {"schemaVersion": 1, "startedAtUTC": now(), "readOnly": True,
          "mainnetTransactionsSent": False, "source": "Own node via SSH domino-host and loopback RPC",
          "token": TOKEN, "collectionCandidate": COLLECTION,
          "discoverySources": ["https://hashcats.fun/", "https://stats.hashcats.fun/"],
          "limitation": "One project-declared canonical pool; not an exhaustive pool inventory.",
          "calls": records}
try:
    report["chainId"] = int(rpc("eth_chainId", []), 16)
    assert report["chainId"] == 4663
    header = rpc("eth_getBlockByNumber", ["latest", False])
    report["block"] = {k: header[k] for k in ("number", "hash", "timestamp")}
    PIN = {"blockHash": header["hash"], "requireCanonical": True}
    report["collectionToken"] = call(COLLECTION, "hashToken()", ["address"])
    assert report["collectionToken"].lower() == TOKEN
    hook = call(COLLECTION, "hook()", ["address"])
    report["hook"] = hook
    package = {}
    try:
        package, report["hookSource"] = source(hook)
        report["sourceMatch"] = {k: package.get(k) for k in ("runtimeMatch", "creationMatch", "verifiedAt", "proxyResolution")}
    except Exception as exc:
        report["hookSource"] = {"unavailable": str(exc)}
    report["reads"] = reads = {}
    for name, types in [
        ("manager", ["address"]), ("key", ["address", "address", "uint24", "int24", "address"]),
        ("currentFee", ["uint16"]), ("feeBps", ["uint16"]), ("FEE_MIN", ["uint16"]),
        ("FEE_MAX", ["uint16"]), ("FEE_DEFAULT", ["uint16"]), ("DECAY_FEE_MAX", ["uint16"]),
        ("DECAY_WINDOW", ["uint256"]), ("decayEndsAt", ["uint256"]),
        ("tradingOpen", ["bool"]), ("poolReady", ["bool"]), ("owner", ["address"]),
    ]:
        try:
            reads[name] = {"value": call(hook, name + "()", types)}
        except Exception as exc:
            reads[name] = {"unavailable": str(exc)}
    key = reads["key"]["value"]
    keybytes = encode(["address", "address", "uint24", "int24", "address"], key)
    poolid = keccak(keybytes)
    report["poolId"] = "0x" + poolid.hex()
    report["poolKey"] = dict(zip(("currency0", "currency1", "fee", "tickSpacing", "hooks"), key))
    slot = keccak(encode(["bytes32", "uint256"], [poolid, 6]))
    manager = reads["manager"]["value"]
    slot0 = call(manager, "extsload(bytes32)", ["bytes32"], [slot], ["bytes32"])
    number = int.from_bytes(slot0, "big")
    tick = (number >> 160) & ((1 << 24) - 1)
    if tick >= (1 << 23):
        tick -= 1 << 24
    report["slot0"] = {"raw": "0x" + slot0.hex(), "sqrtPriceX96": str(number & ((1 << 160) - 1)),
                       "tick": tick, "protocolFee": (number >> 184) & ((1 << 24) - 1),
                       "lpFee": (number >> 208) & ((1 << 24) - 1)}
    liquidity_slot = (int.from_bytes(slot, "big") + 3).to_bytes(32, "big")
    liquidity = call(manager, "extsload(bytes32)", ["bytes32"], [liquidity_slot], ["bytes32"])
    report["activeLiquidity"] = str(int.from_bytes(liquidity, "big") & ((1 << 128) - 1))
    code = rpc("eth_getCode", [hook, PIN])
    report["hookRuntimeCodeHash"] = "0x" + keccak(bytes.fromhex(code[2:])).hex()
    report["hookRuntimeCodeBytes"] = len(code[2:]) // 2
    sourcify_code = package.get("runtimeBytecode", {}).get("onchainBytecode")
    report["hookRuntimeEqualsSourcifyOnchain"] = None if not sourcify_code else code.lower() == sourcify_code.lower()
    end = int(header["number"], 16)
    fee_topic = "0x" + keccak(b"FeeTaken(bool,uint256)").hex()
    swap_topic = "0x" + keccak(b"Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)").hex()
    event_logs = []
    windows = []
    selected = {}
    # At most 100,000 recent blocks, with address and exact event filtering.
    # Stop once an example in each direction exists; never scan from genesis.
    for offset in range(5):
        last = max(0, end - offset * 20000)
        first = max(0, last - 19999)
        window_logs = rpc("eth_getLogs", [{"address": hook, "fromBlock": hex(first),
                          "toBlock": hex(last), "topics": [fee_topic]}])
        windows.append({"fromBlock": first, "toBlock": last, "count": len(window_logs)})
        event_logs.extend(window_logs)
        for event in window_logs:
            buying, amount = decode(["bool", "uint256"], bytes.fromhex(event["data"][2:]))
            selected.setdefault(buying, event)
        if len(selected) == 2 or first == 0:
            break
    report["boundedFeeLogs"] = {"windows": windows, "count": len(event_logs), "logs": event_logs}
    report["tradeExamples"] = []
    for buying, event in selected.items():
        receipt = rpc("eth_getTransactionReceipt", [event["transactionHash"]])
        assert receipt["blockHash"] == event["blockHash"] and receipt["status"] == "0x1"
        swaps = [log for log in receipt["logs"] if log["address"].lower() == manager.lower()
                 and log["topics"][0] == swap_topic and log["topics"][1] == report["poolId"]]
        fee_index = int(event["logIndex"], 16)
        candidates = [log for log in swaps if (decode(["int128"], bytes.fromhex(log["data"][2:66]))[0] < 0) == buying]
        candidates.sort(key=lambda log: abs(int(log["logIndex"], 16) - fee_index))
        example = {"transactionHash": event["transactionHash"], "buying": buying, "feeLog": event,
                   "receipt": receipt, "attribution": "Nearest same-pool Swap with matching ETH direction; verify receipt ordering and any buyback separately"}
        if candidates:
            swap = candidates[0]
            values = decode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], bytes.fromhex(swap["data"][2:]))
            _, amount = decode(["bool", "uint256"], bytes.fromhex(event["data"][2:]))
            gross = -values[0] + amount if buying else values[0]
            example.update({"swapLog": swap, "poolAmount0Wei": str(values[0]), "poolAmount1Raw": str(values[1]),
                            "feeWei": str(amount), "inferredEthFeeBasisWei": str(gross),
                            "matchesCeil500BpsOfEthBasis": gross > 0 and amount == (gross * 500 + 9999) // 10000})
        report["tradeExamples"].append(example)
    report["observedEthFeeBasis500BpsBothDirections"] = len(selected) == 2 and all(
        example.get("matchesCeil500BpsOfEthBasis") for example in report["tradeExamples"])
    # Packed transaction input independently disclosed this second candidate.
    # Its computed ID must equal the ID emitted by PoolManager in that receipt.
    second_key = ["0x" + "00" * 20, TOKEN, 20000, 200, "0x" + "00" * 20]
    second_id = keccak(encode(["address", "address", "uint24", "int24", "address"], second_key))
    assert "0x" + second_id.hex() == "0x4f746505d7ade28eb64160e1a0a30da02e00c4c5c3e4fb70b037f69e279a847e"
    second_slot = keccak(encode(["bytes32", "uint256"], [second_id, 6]))
    second_raw = call(manager, "extsload(bytes32)", ["bytes32"], [second_slot], ["bytes32"])
    second_word = int.from_bytes(second_raw, "big")
    second_protocol = (second_word >> 184) & ((1 << 24) - 1)
    second_lp = (second_word >> 208) & ((1 << 24) - 1)
    second_liquidity_raw = call(manager, "extsload(bytes32)", ["bytes32"],
        [(int.from_bytes(second_slot, "big") + 3).to_bytes(32, "big")], ["bytes32"])
    protocol_directions = [second_protocol & 0xfff, second_protocol >> 12]
    report["secondaryPool"] = {
        "discoveryTransaction": "0xfad65a42b7961d17ae9dfe2f9648955b457ada65411b5e4e870e1761d07e2d59",
        "discoveryRecord": "hash-pool-buy-transaction.json",
        "poolId": "0x" + second_id.hex(),
        "poolKey": dict(zip(("currency0", "currency1", "fee", "tickSpacing", "hooks"), second_key)),
        "poolKeyHashMatchesObservedPoolManagerSwapId": True,
        "slot0Raw": "0x" + second_raw.hex(),
        "sqrtPriceX96": str(second_word & ((1 << 160) - 1)),
        "protocolFeePacked": second_protocol, "lpFeePips": second_lp,
        "protocolFeePipsZeroForOne_OneForZero": protocol_directions,
        "effectiveFeePipsZeroForOne_OneForZero": [f + second_lp - f * second_lp // 1000000 for f in protocol_directions],
        "activeLiquidity": str(int.from_bytes(second_liquidity_raw, "big") & ((1 << 128) - 1)),
        "caveat": "Hookless candidate, not a complete Domino position/execution qualification. Fee units are one million pips per 100 percent."
    }
    report["limitation"] = "Two confirmed ETH/HASH pools; bounded discovery is not an exhaustive pool inventory. Hook source unavailable. Historical trade attribution is descriptive evidence, not a proof of every hook branch."
    report["canonicalityRechecked"] = rpc("eth_getBlockByNumber", [header["number"], False])["hash"] == header["hash"]
    report["status"] = "complete_reads_source_unavailable" if report["canonicalityRechecked"] and not package else "unqualified"
    if report["canonicalityRechecked"] and report["hookRuntimeEqualsSourcifyOnchain"]:
        report["status"] = "complete"
except Exception as exc:
    report["status"] = "partial"
    report["error"] = str(exc)
finally:
    report["finishedAtUTC"] = now()
    report["scriptSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (OUT / "hash-pool-reads.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k not in ("calls", "tradeExamples", "boundedFeeLogs")}, indent=2))
