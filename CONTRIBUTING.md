# Contributing

Follow [Execution first](docs/EXECUTION_POLICY.md), the owner decision of 12 September 2026. It supersedes older planning, ownership and approval gates. `rugged97` and `OxDecimal` are administrators with access across the entire repository; all authorized collaborators and their agents may operate across all project areas.

## Working approach

1. Start the next useful action in the requested scope. Read the relevant current code/state; no issue assignment, advance plan or area-owner acknowledgement is required.
2. Implement the smallest useful increment. Use a branch/worktree when it helps isolate concurrent work; assistant branches use `codex/`. Preserve uncommitted work and resolve overlaps directly.
3. Run checks proportionate to the actual change, reusing valid evidence. CI remains automatic feedback. Optional Windows/browser acceptance and repeated full-suite runs are not universal delivery gates.
4. Integrate with a normal direct push to `main`, or use a small PR when useful. Any authorized collaborator may merge without a second person's approval. Keep forward/linear history and avoid force-pushing or deleting shared main.
5. Record the delivered behavior, actual checks, known problems and useful recovery details after acting. Issues and PRs are coordination records, not permission queues. Fix reported errors promptly.

Task authorization persists through necessary fixes, provisioning, configuration, integration and deployment. Do not ask repeatedly for the same approval. Missing credentials or an external restriction should be reported concretely while other work continues. Do not publish credentials in commits, prompts, logs or browser bundles.

## Cross-area work and subagents

No frontend/backend/contracts/infrastructure area has an exclusive owner. Any collaborator may update both sides of an interface or operate an environment through authorized project access. Delegate independent subtasks when useful, inspect their evidence and integrate their results. Avoid concurrent overwrites using current diffs and isolated worktrees, without reserving areas or waiting for ceremonial handoffs.

Each assistant has its own session history. Publish a short result in the existing issue/PR when needed; a GitHub comment does not automatically wake another assistant. Do not claim monitoring or automatic notifications that were not configured.

## API compatibility and runtime behavior

Use shared schemas, runtime validators and representative producer/consumer fixtures. Keep `backend/openapi-read.json`, `api-contracts/read-v1/` and relevant session exports consistent with real behavior. Follow [API_COMPATIBILITY.md](docs/API_COMPATIBILITY.md) for version semantics and a concise change notice. The implementing collaborator may adapt producer and consumer and integrate immediately; a named person's ACK is not required.

Unknown values remain unavailable. Public NFT ownership is not wallet authentication; a connected wallet or login does not supply spending consent. Keep existing data integrity, secret handling and runtime access controls correct. This process change does not fabricate live capabilities, signatures or qualified data.

## Checks and delivery

README lists reproducible frontend, backend, PostgreSQL/Anvil, Solidity and repository-hygiene checks. Choose the checks affected by a change and report their results. CI remains unprivileged and independent of real provider/wallet keys. Tests and feedback guide corrections without a mandatory reviewer/CI waiting gate on main.

Any authorized collaborator may deploy and recover the scoped project. Use the actual target's documented commands and credentials. For Sites, retain its hosting identity and use the frontend-only checkout so deployment does not replace this repository's Git remote. A provider account permission is an actual access constraint, not a permanent assignment to a particular person.
