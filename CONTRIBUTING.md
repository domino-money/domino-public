# Contributing

`rugged97` and `OxDecimal` are repository administrators with access across frontend, backend, contracts, documentation and settings. Code ownership requests review; it does not restrict read/write access. OxDecimal initially focuses on frontend; rugged97 coordinates backend, contracts and integration. Either may contribute anywhere.

## Task workflow

1. Pick an issue and assign yourself before starting. State which files and API boundaries you expect to touch. If another task overlaps, agree on the contract first.
2. Branch from current `main`: `codex/<issue>-<topic>` for assistant work or `feature/<issue>-<topic>` for manual work. Use a separate clone/worktree for simultaneous tasks.
3. Give your assistant AGENTS.md, the issue's acceptance criteria and the relevant specs. Never transfer credentials through prompts.
4. Open a small pull request. Explain the observable change, limitations and checks; include screenshots for visible changes when helpful.
5. The other collaborator reviews. Main requires one approval, passing CI and resolved conversations. New commits dismiss stale approvals. Squash merge after checks pass; the branch is then deleted.

Full administrative access includes settings and workflows, so protection is a shared development policy rather than isolation from either administrator. No directory is reserved exclusively to one contributor. If the invitation is pending, cross-review becomes available after it is accepted.

## API handoff

`backend/openapi-read.json` is the versioned request contract. Existing Python test fixtures and explicit response-state semantics are the evidence for adapters; proposing response types may require a backend contract update. Do not pretend today's practice API is the read backend. Start frontend integration behind a mock adapter. A real same-origin bridge, authentication and public deployment are separate reviewed work.

Unknown prices remain unavailable. A connected wallet, discoverable pool or readable NFT owner does not authorize an automated transaction. Fee policy, permission and contract changes need explicit acceptance criteria and relevant accounting/security tests.

## Checks and releases

See README.md for reproducible setup. CI runs frontend checks, all backend tests with isolated PostgreSQL/Anvil, Solidity unit/fuzz tests and repository hygiene. No production secrets are required. Do not store personal provider keys in Actions while these tests are fully offline.

GitHub publication and Sites deployment are separate. Run Sites publishing from an isolated frontend-only checkout while retaining its approved hosting identity. The existing private preview remains under its deployment owner's account. Public backend deployment and live contract activation require their own completed evidence gates.

Use issues and labels as the initial task board. Priorities are labels; dependencies belong in issue bodies. A GitHub Project can be added later without changing this workflow.
