# Stored public reads, read-v3

Additive, opt-in routes `overview`, `search` and `history`. V1 and V2 remain unchanged. Generated schemas and types come from `backend/public_data_contract.py`; regenerate with `backend/.venv/bin/python scripts/export-read-v3-contract.py`.

Overview returns bounded stored observations and separate acquisition status. An accepted request is not evidence that acquisition finished. Null values remain absent. Nested tokens use read-v1, markets and APR estimates use read-v2; original timestamps remain authoritative. Search covers known verified tokens, not all tokens on the chain. Token overview pagination is pinned to its revision.

History is a pool ratio in `quoteCurrency` per unit of `currency`. It is never a USD series. Coverage and gaps are explicit; missing history is never a zero candle. Limits constrain each request, not which tokens can be requested.

Consumers validate the exact header, response and `matchesRequest` before using data. `runtime.mjs` reuses nested V1/V2 validators and rejects inconsistent identity, evidence, capability, cursor and series shapes. Public data does not authenticate wallets or enable execution.
