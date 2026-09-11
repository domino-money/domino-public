# Contributing

`rugged97` and `OxDecimal` are repository administrators with access across frontend, backend, contracts, documentation and settings. Code ownership requests review; it does not restrict read/write access. OxDecimal initially focuses on frontend; rugged97 coordinates backend, contracts and integration. Either may contribute anywhere.

## Task workflow

1. Pick an issue and assign yourself before starting. State which files and API boundaries you expect to touch. If another task overlaps, agree on the contract first.
2. Branch from current `main`: `codex/<issue>-<topic>` for assistant work or `feature/<issue>-<topic>` for manual work. Use a separate clone/worktree for simultaneous tasks.
3. Give your assistant AGENTS.md, the issue's acceptance criteria and the relevant specs. Never transfer credentials through prompts.
4. Open a small pull request. Explain the observable change, limitations and checks; include screenshots for visible changes when helpful.
5. The other collaborator reviews. Main requires one approval, passing CI and resolved conversations. New commits dismiss stale approvals. Squash merge after checks pass; the branch is then deleted.

Full administrative access includes settings and workflows, so protection is a shared development policy rather than isolation from either administrator. No directory is reserved exclusively to one contributor.

## Working with subagents

Subagent delegation is approved for independent parts of an issue. Follow the scope and integration rules in [AGENTS.md](AGENTS.md): one coordinating agent, explicit file ownership, separate worktrees for simultaneous implementation, and verification of the combined result.

At the beginning of a task and before opening or updating its PR, read the latest issue comments and related changes. Each collaborator's assistant has its own session history; only published code, documentation and issue/PR discussion are shared. GitHub comments do not automatically wake a local assistant. Keep handoffs concise and tied to a concrete question, decision, dependency or result. Automated review or event-driven coordination needs its own configuration.

## API handoff

`backend/openapi-read.json` describes local requests and the five bridge response models. `api-contracts/read-v1/` is the shared candidate response/request contract with TypeScript types, runtime validators and producer fixtures; regenerate both exports after model changes. Do not pretend today's practice API is the read backend. Start frontend integration behind a mock adapter. A real same-origin bridge, authentication and public deployment are separate reviewed work.

Unknown prices remain unavailable. A connected wallet, discoverable pool or readable NFT owner does not authorize an automated transaction. Fee policy, permission and contract changes need explicit acceptance criteria and relevant accounting/security tests.

The separate disabled session candidate uses `api-contracts/session-v1/` and
the same compatibility/notice process. Its signature proves login only; no
session bearer may enter the public reader or frontend storage. Regenerate its
schemas/types/fixtures with `scripts/export-session-contract.py` and keep both
its BFF and listener disabled until the documented integration gates pass.

Before connecting real data or changing fields consumed by the frontend, follow
[API_COMPATIBILITY.md](docs/API_COMPATIBILITY.md): post the exact version/field
notice, shared fixtures, affected hooks, test results and rollback to the issue
and obtain the frontend owner's acknowledgement before integration. The
[issue #5 bridge design](docs/API_READ_BRIDGE.md) preserves existing local API
restrictions. Its disabled implementation candidate is not a deployed public service.

## Checks and releases

See README.md for reproducible setup. CI runs frontend checks, all backend tests with isolated PostgreSQL/Anvil, Solidity unit/fuzz tests and repository hygiene. No production secrets are required. Do not store personal provider keys in Actions while these tests are fully offline.

GitHub publication and Sites deployment are separate. Run Sites publishing from an isolated frontend-only checkout while retaining its approved hosting identity. The existing private preview remains under its deployment owner's account. Public backend deployment and live contract activation require their own completed evidence gates.

Use issues and labels as the initial task board. Priorities are labels; dependencies belong in issue bodies. A GitHub Project can be added later without changing this workflow.
