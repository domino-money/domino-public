# Execution first

Owner decision, **12 September 2026**. Effective immediately across Domino and all collaborating assistant sessions. Deliver working progress first; update plans and coordination records afterward.

This is the authoritative repository **process policy**. It supersedes older requirements in AGENTS, contribution guides, runbooks, issues, PRs and handoffs for area ownership, advance planning, mandatory PRs, peer approvals, consumer acknowledgements and acceptance ceremonies. The owner's latest instructions take precedence. Historical evidence remains historical; technical contracts and actual runtime behavior are not changed by a process decision.

## Shared autonomy

- Every authorized collaborator and their delegated agents may work across frontend, backend, contracts, APIs, data, infrastructure, deployment, recovery, CI and repository settings. There are no exclusive areas, designated gatekeepers or obligatory handoffs to Rugged, Decimal or another specialist.
- Use the project's existing authorized accounts and access. Provision or adjust project access needed for the assigned work within the owner's authorization; do not wait for an area owner. Repository policy does not itself create credentials or prove access to an external account. Report a concrete missing credential or provider restriction and continue independent work.
- Task authorization carries through necessary implementation, fixes, configuration, provisioning, integration and deployment within its scope. Do not ask again for the same authorization at each step, commit, environment or small correction. Ask only when essential information is unavailable or an actual external/higher-priority requirement prevents the action; identify that exact blocker.
- Shared authority means access for authorized project collaborators, not publishing credentials or exposing private services/data to everyone on the Internet. Keep secrets in private configuration and approved secret channels. Existing software authentication, financial consent and data-integrity behavior remain technical requirements.

## Execute, verify, then record

1. Take the next useful action in the owner's current priority. Read only enough current code/state to act correctly. A plan, issue, assignment or another person's reply is not a prerequisite.
2. Deliver the smallest useful working increment. Fix a concrete problem when it appears; use a focused rollback if that restores service faster. Avoid speculative frameworks, exhaustive preflight documents and redesigns without evidence they are needed.
3. Choose checks proportionate to the actual change. Reuse existing evidence and rerun affected checks only. CI continues as automatic feedback; it is not a mandatory waiting room. An unfinished optional test or external acceptance session does not prevent making a working environment available.
4. Record the result briefly after the action: what works, commit/environment, checks actually run and concrete remaining problems. Never report unperformed tests as passed. Update the existing issue/PR when useful; do not create a chain of approval requests or duplicate handoffs.

## Git and review

- Direct, normal pushes to `main` are allowed. Branches and PRs are optional tools for isolation, collaboration and review, not universal prerequisites. Use `codex/` for assistant-created branches.
- Any authorized collaborator may integrate, merge or deploy the scoped work without another collaborator's approval. Independent review is available when it helps; its timing may be before, alongside or after delivery. Do not request a second review solely because an edit crosses an area boundary.
- GitHub has no required PR, approving reviewer, CODEOWNER, conversation-resolution, current-base or status-check gate on `main`. CI workflows still run and surface failures for prompt correction. Retain linear history and protection against force-push/deleting `main`; normal forward integration does not need either operation.
- A concrete review finding is work to assess and fix, not a reason to restart a full planning/review cycle. Review only the changed delta. No fabricated/self-issued independent approval is necessary or acceptable.
- Preserve other work. Inspect active changes, use separate worktrees when useful, integrate compatible edits and resolve conflicts directly. A temporary coordination note prevents an overwrite; it does not reserve a directory or require permission to work there.

## API and operational changes

Any collaborator may update producer and consumer together and operate the required services. Keep contracts, fixtures, version semantics and configuration consistent. Publish a concise compatibility/activation notice with the delivered change; an acknowledgement from a named consumer or operator is not an admission gate. Handle real incompatibilities by adapting, migrating or rolling back, not by waiting indefinitely for replies.

When the owner waives a test or acceptance step, record the waiver and proceed. In particular, the owner waived Windows/HMR/hot-admission acceptance as a prerequisite for issue #132: keep its authorized development access available and address reported errors. Do not interrupt that access to perform the cancelled test.

## Effective GitHub configuration

Both `rugged97` and `OxDecimal` already have administrator access. The former area-based review ruleset is disabled, `CODEOWNERS` has no ownership patterns, and classic `main` protection has no required reviews/status checks/conversation resolution. CI execution, secret handling, linear history and no-force-push/no-delete remain in place. This policy does not introduce new public collaborators, grant unrelated accounts access or enable unimplemented financial capabilities.
