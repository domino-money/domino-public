# Proportionate review

Owner decision, 11 September 2026. PR #64 is the motivating example: its small
presentation change should have used the author's existing visual validation and
current CI, without a second full review/browser matrix.

## Small changes by the responsible owner

OxDecimal leads frontend presentation; rugged97 leads backend, contracts and
integration. Both retain full repository access. For a small, reversible change
within the owner's area, author validation and passing CI replace peer review.
Record the purpose, the affected state and the check already performed in the PR.
Do not duplicate that work by default. A concrete failure, changed source or
unresolved regression justifies a focused additional check.

Eligible examples are spacing, colours, typography, decorative backgrounds,
static token artwork and local wording that preserves product meaning. A large
indentation diff can still represent a small semantic change. There is no
arbitrary line-count score or new approval bot.

Independent review still applies to substantial/cross-area changes and anything
affecting financial values or availability/qualification semantics, wallet
identity/access/sessions, signatures/approvals/swaps/deposits, API/schema
boundaries, databases/migrations/ledgers, provider trust, dependencies/build/CI,
deployment, security or this policy. Hiding a warning or changing a financial
label is not merely cosmetic. These conditions also apply to exempt UI files.

## Native GitHub enforcement

All main changes still require a PR, the four existing CI checks, an up-to-date
base, resolved conversations and linear/squash history. No direct-push,
force-push, deletion or administrator-bypass exception is added.

The main review ruleset requires one approval from the existing two collaborators,
represented by the `domino-reviewers` team, for every path **except**:

- `app/src/styles/tokens.css`
- `app/src/components/Header.tsx`
- `app/src/components/HeroBackdrop.tsx`
- `app/src/components/Footer.tsx`
- `app/src/screens/Landing.tsx`
- `app/public/tokens/*.svg`

These are presentation surfaces in the current app. Data adapters, ticker/market
figures, receipts, funding/onboarding components, runtime configuration and all
backend/contracts/bridge/shared domain code remain under the normal native review
requirement. An unlisted cosmetic file needs a deliberate boundary update rather
than a protection bypass. The matching CODEOWNERS entries suppress automatic
peer-review requests after this document's PR is integrated.

GitHub matches files; it does not determine whether an edit is small, cosmetic or
made by its area owner. That part is an explicit contributor/agent responsibility.
If an exempt file gains sensitive behavior, request normal independent review
and restore its protected classification. Never treat path matching as evidence
that financial or authentication changes are safe.

Implementation uses a native pull-request ruleset with zero blanket approvals
and one file-pattern-based team approval (`**`, followed by the exclusions
above). The classic blanket approval/code-owner requirement is reduced to zero
only after that replacement rule is active and read back successfully. Existing
status-check/admin/force-push/conversation protections remain intact. The reviewer
team receives write access to this repository only; both members already have
administrator access. The PR author cannot provide the independent approval.

[GitHub's required-reviewer rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#required-reviewers)
support ordered file patterns and exclusion patterns. This is a native path
boundary, not a workflow that evaluates or approves contributed code.

## Agent handling

1. Confirm ownership, small scope and absence of sensitive/cross-area changes.
2. Reuse the author's stated focused validation and current-head CI. Do not rerun
   the full app/backend suite or spawn a second reviewer by default.
3. If eligible, proceed under the user's merge authorization without waiting for
   peer approval. Approval of this policy is not blanket deployment authority.
4. Otherwise use normal independent review, with tests proportionate to the
   actual change. Keep feedback focused on actionable defects.
