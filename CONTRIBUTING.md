# Reviewing and contributing

Domino is published for transparency, consultation and security review. Read the
[source availability and review terms](LICENSE.md) before using the code.
Existing file-level and third-party licenses retain their own permissions.

## Public review

Use the [local fixture walkthrough](README.md#run-locally) and the checks for the
layer you are reviewing. The limited review permission covers local evaluation
and tests of otherwise unlicensed Domino material. It does not grant production
deployment or general redistribution rights.

Public issues are useful for reproducible bugs, documentation corrections and
questions. Include the revision, expected behavior, observed behavior and a
minimal reproduction using synthetic data. Never post credentials, private
configuration, wallet material or sensitive vulnerability details publicly.

For code contributions, state the applicable license or permission and confirm
that you have the right to submit the material. Do not assume that a GitHub fork,
issue or pull request creates a general license to reuse the project. This guide
introduces no copyright assignment or blanket license for contributions;
applicable component licenses, separate agreements and GitHub's terms continue
to govern those submissions.

## Preparing an authorized change

1. Start from this public repository. Do not merge private repository branches;
   that would reintroduce unsanitized history. See the
   [publication provenance](docs/PUBLIC_SANITIZATION.md).
2. Keep the change focused and preserve other contributors' work. Use a branch
   or worktree when useful; assistant branches use `codex/`.
3. Preserve file-level licenses, attribution, source provenance and frozen audit
   artifacts. Changes to frozen contract sources are new candidates and follow
   the [freeze procedure](docs/v2/FREEZE.md).
4. Run checks proportionate to the change and report what actually ran, any
   failures, and skipped checks. The [README](README.md#tests) lists the commands;
   [Public CI](docs/PUBLIC_CI.md) explains the hosted suite's limited scope.
5. Include a concise explanation of the behavior, relevant validation and any
   remaining problem with the patch.

Shared API schemas and runtime validators must reflect producer and consumer
behavior. Keep affected OpenAPI exports and fixtures aligned, following the
[compatibility guide](docs/API_COMPATIBILITY.md). Missing or unqualified data
must remain explicit; do not invent balances, prices or returns. Wallet login
and NFT ownership reads do not supply consent to spend funds.

## Authorized maintainers

The [execution policy](docs/EXECUTION_POLICY.md) governs work already authorized
by the project owner. Such collaborators may work across project areas and use
normal direct pushes or pull requests within their granted access. Preserve
linear history and protection against force-pushing or deleting `main`.

Public visibility does not grant write access, deployment authority, credentials
or access to private services. Work in Domino-managed environments requires
project authorization and access; existing task authorization remains valid.
Keep public CI unprivileged and independent of operational provider keys and
wallets.
