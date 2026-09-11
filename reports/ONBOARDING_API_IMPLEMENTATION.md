# Authenticated onboarding previews — implementation evidence

Issue: [#38](https://github.com/domino-money/domino/issues/38).

The backend now exposes session-bound swap and existing-pool position previews
through the `onboarding-v1` 1.0.0 candidate. It reuses the Uniswap adapters from
#35/#37 and the SIWE session store from #33. The browser cannot select an owner
or recipient; the service derives both from the active session. The standalone
worker and private listener remain disabled by default.

## Delivery and review boundaries

- Service, private HTTP listener and separate browser worker for the two POST
  preview routes, with closed request/response validation and exact request binding.
- Durable IP/account/global budgets shared by both routes; fresh session, chain,
  CSRF and deadline checks before and after provider work. Logout, expiry and
  CSRF rotation invalidate an in-flight result.
- Shared schemas, TypeScript types, runtime validators, deterministic fixtures,
  producer hashes and compile-time consumer checks. CI verifies the new package.
- Runbook: [ONBOARDING_API.md](../docs/ONBOARDING_API.md), including exact fields,
  expiry/error handling, resource limits, eventual configuration and rollback.

The task branch starts from #37 at
`713c1450abeaa73498b7900b0c2242d79135a215`, then merges #33 at
`f3ec1dc69d6e56700b21c5b2278fe5e81d4bb9e2` into the task-local integration commit
`011eb81062ed8cfab2ab5cd1d46e92825b0ccc56`. Review the feature changes relative to
that integration commit; the stacked PR also contains its session dependency.
Neither dependency branch nor main was changed by that merge.

Manifest SHA-256 for the delivered candidate:
`fa409cf61e91de7306ba8b075810766232b388c16975e3a17f7b9d03f91b93eb`.

## Local validation

| Check | Result |
| --- | --- |
| Full Python suite with PostgreSQL and EVM enabled | 649 passed; zero skipped |
| Complete bridge suite and syntax checks | 503 passed; zero skipped |
| Read contract and OpenAPI export drift checks | Passed |
| Session and onboarding contract export drift checks | Passed |
| Strict TypeScript contract and consumer compilation | Passed |

The 59 new backend tests cover auth/storage, service, listener, contract and four
HTTP integration flows. Those flows use a synthetic SIWE signing key, the real
session store and HTTP handlers, and the existing adapters with synthetic
provider responses. External HTTP is blocked. They exercise successful previews
and revocation, absolute/idle expiry and CSRF rotation around provider work,
including retained quotas after rejection. The new bridge/contract tests add 138
cases to the dependency baseline.

Task-local PostgreSQL was stopped after verification. No real provider key,
personal-bot runtime, wallet funds or financial transaction was used. Synthetic
HTTP evidence does not qualify real HTTPS cookies or Cloudflare ingress.
Independent agent reviews of service/auth/listener and contract/worker boundaries
reported no actionable findings; these are implementation reviews, not an
external security audit or a GitHub reviewer approval.

## Remaining integration gates

OxDecimal's frontend can implement against the versioned package and fixtures.
Amount/range/review hooks must handle exact raw strings, nullable/unverified
budgets, expired previews and fixed errors. Browser integration and activation
still require the explicit consumer acknowledgement and evidence described in
[API_COMPATIBILITY.md](../docs/API_COMPATIBILITY.md).

Cloudflare configuration and credentials for `domino.money` remain deferred.
Staging must verify exact HTTPS origins/cookies, separate Access identities,
trusted ingress IP metadata, bounded capacity and redacted logging. The existing
external security review remains a public-release gate.

No frontend source, public deployment or financial capability is enabled by this
feature. Preview execution flags remain false. It does not select the assisted
swap tariff, duplicate LP math, implement new-pool initialization, authorize
signatures, broadcast transactions or reconcile receipts. Those are separate
deliverables, not implied by successful authentication.
