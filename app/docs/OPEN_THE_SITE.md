# Open the site without the password

One setting, `BETA_GATE`, opens domino.money to everyone. It is off by default:
until someone sets it, the site keeps asking for the password exactly as it does
today.

- `BETA_GATE` set to exactly `off` (lowercase, nothing around it): the site is
  open. Every page, file and `/api` route is served as it is today to a visitor
  who typed the password, with the same security headers, CSP, caching and
  routing. No password page, no cookie. `/__beta/login` and `/__beta/logout`
  just send the visitor to Home, so a tab left on the old password page lands on
  the app when its form is sent.
- Any other value (`OFF`, ` off`, `false`, empty) or no setting at all: the
  password page, byte for byte as before, including the 503 "Access is paused"
  page when the two secrets are missing. A typo can only leave the site closed.

Opening does not depend on the password: with `BETA_GATE` set to `off` the site
opens even without BETA_PASSWORD and BETA_COOKIE_KEY, or with either too weak.
Leave both secrets as they are anyway: they are what the site goes back to when
you close it again. Never delete or change them to open the site.

The setting is per environment. Production and the preview each read their own,
and nothing in `wrangler.toml` sets it, so the preview keeps the password unless
its own settings say `off` too (not needed for the launch).

The code is in `functions/_lib/gate.ts` (`gateOpen`) and `functions/_middleware.ts`;
`tests/gate.test.mjs` and `tests/gate.browser.test.mjs` cover it.

## Before you start

- Production must be running a release that contains this change. An older
  release ignores `BETA_GATE` and stays closed.
- Set `BETA_GATE` only when you mean to open the site. Do not set it early:
  the next production deployment of a release with this change, whoever makes
  it and for whatever reason, picks it up and opens the site.
- `wrangler.toml` declares `[vars]` for both environments, so the dashboard
  cannot hold plain-text variables for this project. `BETA_GATE` is therefore a
  Pages **secret**, like `BETA_PASSWORD`.
- Pages applies a changed secret to deployments made after the change, so each
  switch below ends with a new production deployment of the same release.
- Run the commands in your own terminal, in the repository's `app` folder, after
  `npx wrangler login`. The deployment step runs in the release checkout that
  last deployed production (the one whose `.release/deployed.json` lists the
  current release on preview), as the README's **Deploying.** section says. In
  a new checkout of the same commit, run `npm run release:build` and
  `npm run deploy:preview` there first.

## Open the site

1. Set the secret for production (no `--env`: production only):

   ```sh
   npx wrangler pages secret put BETA_GATE --project-name domino-app
   ```

   At `Enter a secret value:` type `off` and press Enter. Wrangler answers
   `Success! Uploaded secret BETA_GATE`.

   The same in the dashboard: Workers & Pages → `domino-app` → Settings →
   Variables and Secrets, environment **Production** → Add, type **Secret**,
   name `BETA_GATE`, value `off`.

2. Deploy the same release to production again, so the secret applies:

   ```sh
   npm run release:verify
   npm run deploy
   ```

   The files and the digest stay the same; only the setting is new.

3. Check, in PowerShell (`curl.exe`, not `curl`):

   ```powershell
   curl.exe -s -o NUL -w "%{http_code}`n" https://domino.money/
   curl.exe -s https://domino.money/api/read/v1/capabilities
   curl.exe -s -o NUL -w "%{http_code}`n" https://preview.domino-app-e65.pages.dev/
   ```

   Open: the first prints `200` (it was `401`), the second prints the read
   service's own answer instead of `{"error":"beta_access_required"}`, and the
   preview still prints `401`. Then open https://domino.money in a private
   window: Home appears with no password page. If the first still prints `401`,
   step 2 has not finished or the value is not exactly `off`: set it again.

Later releases keep the site open: the secret stays until you delete it.

## Close it again

1. Delete the secret (answer `y`), or set it to any other value with step 1
   above:

   ```sh
   npx wrangler pages secret delete BETA_GATE --project-name domino-app
   ```

2. Deploy the same release to production again: `npm run deploy` in the release
   checkout.

3. Check, in PowerShell:

   ```powershell
   curl.exe -s -o NUL -w "%{http_code}`n" https://domino.money/
   ```

   Closed: it prints `401`, and a private window shows the password page.
   Testers whose beta cookie is still inside its week get in without typing the
   password again; everyone else types it, as before.

## Left as it is, for the owner to decide

- Search engines: every answer carries `X-Robots-Tag: noindex, nofollow`, open
  or not, so domino.money stays out of search results after opening. Listing it
  is a separate change (`BASE_HEADERS` in `functions/_middleware.ts` and its
  tests), not made here.
- Rate limits: before a wide audience arrives, Cloudflare rate limiting rules on
  `/api/*` and `POST /api/session/*` per client address are worth adding in the
  dashboard.
