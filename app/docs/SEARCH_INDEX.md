# Let Google list domino.money

One setting, `SEARCH_INDEX`, lets search engines list the site's main pages. It
is off by default: until someone sets it, every answer keeps
`X-Robots-Tag: noindex, nofollow`, exactly as before.

- `SEARCH_INDEX` set to exactly `on` (lowercase, nothing around it), and only on
  `domino.money` itself: the 29 pages listed in `sitemap.xml` (Home, Markets,
  New position, Positions, Automate, the docs and each docs page), the favicon
  and the shared picture (`/og.png`) carry no noindex. Every other page the app
  opens (a pool, a position, Receipts, another address, a setup, a section)
  answers `noindex` (its links still followed), and a 404 too. So does
  `sitemap.xml` itself: never a result, its addresses all followed.
- Everywhere else nothing changes, whatever the setting says: the preview, every
  `pages.dev` address, `www.domino.money` (a redirect), any other host, the API,
  the files and the password page keep `noindex, nofollow`.
- Any other value (`ON`, ` on`, `true`, empty) or no setting at all: off.

What every address answers does not depend on the setting: each page has its own
title, description, canonical address and shared-link preview, older names and a
trailing slash move to the page's own address with a 301, and an address the app
has nothing at answers 404 with the app's own "This page doesn't exist". A HEAD
answers as its GET does, without the body. The words are the build's
(`src/lib/seo/heads.ts`, `src/lib/seo/table.ts`); the edge reads them from the
page (`functions/_lib/seo.ts`). `robots.txt` stays Cloudflare's managed file;
the sitemap goes to Search Console directly.

A page to keep out of search (a future points page): add it to `MAIN_PAGES` in
`src/lib/seo/heads.ts` with `index: false`. It gets its own words, `noindex`
(meta and header) and no place in `sitemap.xml`.

## Switch it on

Like `BETA_GATE` (`docs/OPEN_THE_SITE.md`): `wrangler.toml` declares `[vars]`, so
it is a Pages **secret**, production only, and it applies to deployments made
after it is set.

1. In the repository's `app` folder, after `npx wrangler login`:

   ```sh
   npx wrangler pages secret put SEARCH_INDEX --project-name domino-app
   ```

   At `Enter a secret value:` type `on`.

2. Deploy the same release to production again (`npm run release:verify`, then
   `npm run deploy`, in the release checkout), so the secret applies.

3. Check, in PowerShell (`curl.exe`):

   ```powershell
   curl.exe -s -D - -o NUL https://domino.money/markets
   curl.exe -s -D - -o NUL https://domino.money/pool/0x00
   curl.exe -s -D - -o NUL https://preview.domino-app-e65.pages.dev/
   ```

   The first has no `x-robots-tag`; the second says `noindex`; the third still
   says `noindex, nofollow` (and asks for the password).

To switch it off again, delete the secret (or set it to anything else) and
deploy again.

## Known limits

- **The preview's password page and a section.** On the preview, a clean
  address with a section (`/docs/risks#who`) opens `/docs/risks` after the
  password, without `#who`: the browser never sends the section to the server,
  and the access page's own script (`functions/_lib/gate.ts`) carries only a
  `#/…` route. The old form (`/#/docs/risks#who`) keeps it. Production has no
  password.
- **Rolling production back past this release.** The release before it reads
  only the `#/…` form. Rolled back, every clean address made in the meantime
  (bookmarks, shared links, a tab reloaded after a release) opens Home instead
  of its page; nothing breaks and every `#/…` link still works. That release
  does not read `SEARCH_INDEX` and answers `noindex, nofollow` everywhere, so
  the listed pages start dropping out of Google until this one is back.
