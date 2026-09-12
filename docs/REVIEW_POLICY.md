# Review supports execution

Superseded owner decision: the 11 September area-owner/UI exception has been replaced by [Execution first](EXECUTION_POLICY.md), effective **12 September 2026**.

- All authorized collaborators and agents may work across every area. There are no named owners, path exceptions or mandatory handoffs.
- Direct normal pushes to main are allowed; PRs and peer reviews are optional coordination tools. Any authorized collaborator may merge and deploy within the current task authorization without another person's approval.
- Use a focused review when it adds value, before, alongside or after delivery. Reuse evidence and inspect only affected deltas. Do not turn every correction into a new full audit or wait for an ACK to update both sides of an API.
- Choose proportional tests. CI still runs and reports failures; GitHub does not require it to finish before integration. Investigate and fix actual failures promptly. Never report an unperformed test as passed.
- Record concrete defects with reproduction/impact and fix them directly or roll back the affected increment. Do not block on speculative findings, cosmetic preferences or optional acceptance ceremonies.

## GitHub settings

The previous area-based ruleset `Independent review outside small UI presentation changes` is disabled. Classic main protection has no required pull request, reviewer, status check, up-to-date-base or resolved-conversation gate. CODEOWNERS has no assignment patterns. Both existing collaborators retain administrator access.

Linear history and no-force-push/no-delete protection remain. CI workflows, authentication and private credential handling remain operational. No self-approval or simulated independent approval is needed: this policy removes the approval dependency itself.

Historical PRs and runbooks may describe the earlier approval process. Their technical contracts and recorded results remain useful; their ownership and procedural approval requirements no longer govern new work. The latest owner scope and [execution policy](EXECUTION_POLICY.md) do.
