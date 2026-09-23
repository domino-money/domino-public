# Execution status v1

Owner-isolated status and finalized canonical receipts, read through a SIWE session and CSRF. No signed bytes, plan, key material, arbitrary query or execution/cancel endpoint is exposed. `executionAvailable:false` states that this API grants no execution authority; it does not hide receipts from an independently running executor.

POST `/api/execution/v1/status` or `/api/execution/v1/list`, with `X-Domino-Execution-Contract: 1.0.0-rc.1`. Missing and foreign intents return the same `item:null`. Lists use an owner-bound keyset, at most 20 rows and 128 KiB. Consumers clear private data on session, wallet, chain and visibility changes; no more than one refresh per 30 seconds.

POST `/api/execution/v1/availability` with a lowercase sequence `vault` to ask whether the live automation loop is ready for that authenticated owner and vault. Only `serve` writes its owner-scoped heartbeat after a healthy pass with matching operator/publisher identities, enabled policies, and the gas-reservation socket. The reader returns `operational:false` for missing, foreign, failed, or older-than-45-second heartbeats. A positive answer expires within 10 seconds; the owner page rechecks before preparing Resume and again before sending it to the wallet. This route never signs, resumes, or grants execution authority.

Run `backend/.venv/bin/python scripts/export-execution-contract.py --check` and `node --test api-contracts/execution-v1/consumer.test.mjs`. Fixtures are synthetic. The gateway and Worker remain disabled until the release profile's identities and admission are installed.
