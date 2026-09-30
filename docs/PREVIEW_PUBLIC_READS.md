# Gated preview public reads

The preview alias `https://preview.domino-app-e65.pages.dev` is the owner's
real-data validation environment. Its beta password remains mandatory. The
public-read adapter is confined to Pages; it does not modify the VM, tunnels,
production Workers, financial capabilities or the production deployment.

## Boundary

- Preview receives only the existing `READ_BRIDGE` service binding and the
  explicit `PREVIEW_PUBLIC_READS=true` opt-in.
- Only the exact HTTPS alias and existing `/api/read/v1/` through `/api/read/v5/`
  families are eligible. The read Worker still validates exact routes, methods,
  contracts, payloads, response provenance and current backend admission.
- Pages validates the original browser Host, Origin and Fetch Metadata before
  translating this fixed read alias to the Worker's canonical app origin. POST
  requires the preview Origin. GET capabilities may omit Origin. Foreign Origins,
  cross-site/navigation metadata and Worker subrequests remain refused.
- No caller chooses an upstream URL. Cookies, beta credentials, Authorization,
  Access credentials and forwarding headers are removed as before. The original
  edge client IP remains available for the existing shared read budget.
- All wallet/session/financial families are refused on preview even if another
  binding is accidentally configured. Other Pages/hash/branch hosts stay denied.
- Preview uses the existing public-read caches with keys isolated by origin;
  it never shares production cache entries. The beta gate and preview admission
  checks run before cache access, including for warm entries. Freshness windows,
  stale-data qualification and backend quotas are unchanged.
- Production request handling and its seven bindings are unchanged.

## Release and verification

Publish preview only after the owner's authorization, validate it with the
owner, then use a PR with passing checks before integrating to main. Production
requires a separate owner release. Never use a combined preview+production
workflow to satisfy a preview-only request. Preserve the beta gate in both.

Checks cover the forwarder against the real read Worker with controlled upstream
fixtures, original browser admission, credential stripping, private-family
refusal, unchanged production handling and actual Wrangler environment parsing.
Live verification must separately demonstrate real pool figures through the
preview and refusal without the beta session. Do not claim any wallet signature
or financial operation was tested by these read checks.

Rollback is preview-only: restore the prior preview deployment or set the preview
opt-in false and rebuild/redeploy preview. Do not stop tunnels or change production.
