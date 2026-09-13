# Execution status v1

Owner-isolated status and finalized canonical receipts, read through a SIWE session and CSRF. No signed bytes, plan, key material, arbitrary query or execution/cancel endpoint is exposed. `executionAvailable:false` states that this API grants no execution authority; it does not hide receipts from an independently running executor.

POST `/api/execution/v1/status` or `/api/execution/v1/list`, with `X-Domino-Execution-Contract: 1.0.0-rc.1`. Missing and foreign intents return the same `item:null`. Lists use an owner-bound keyset, at most 20 rows and 128 KiB. Consumers clear private data on session, wallet, chain and visibility changes; no more than one refresh per 30 seconds.

Run `backend/.venv/bin/python scripts/export-execution-contract.py --check` and `node --test api-contracts/execution-v1/consumer.test.mjs`. Fixtures are synthetic. The gateway and Worker remain disabled until the release profile's identities and admission are installed.
