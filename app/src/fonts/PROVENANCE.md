# Where these fonts come from

Downloaded on 2026-09-28 for the speed wave (item 35 of the speed study, approved by the owner): the files Google Fonts
served for the stylesheet `index.html` linked until then,

    https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600;650&family=Geist+Mono:wght@400;500&display=swap

asked with a current Chromium's user agent (Chrome 140 on Windows), which is what a visitor's browser received: woff2
files split by script (`unicode-range`). Each file is Google's, byte for byte, renamed only. `../styles/fonts.css` is Google's
stylesheet with each `url()` pointed at the file here; `tests/fonts.test.mjs` checks the stylesheet against the one
Google served (kept as `tests/support/google-fonts-2026-09-28.css`) and every file against its SHA-256 below.

| File | Bytes | Source | SHA-256 |
|---|---:|---|---|
| `geist-cyrillic-ext.woff2` | 7,420 | `https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwRGFWfOw.woff2` | `2317fa4bb293c9c0b110e18315d529235c47a0ddd3338cea3d8c7955e927899e` |
| `geist-cyrillic.woff2` | 15,084 | `https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwYGFWfOw.woff2` | `6894439694946a589d157ece003086960a6a4013d74a813dab7602efdb3d8c09` |
| `geist-latin-ext.woff2` | 16,512 | `https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwSGFWfOw.woff2` | `824f485b5d26e2f2da3c2b236132ece1bc8e4e43373452950bb0e40548b4313f` |
| `geist-latin.woff2` | 29,400 | `https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwcGFU.woff2` | `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1` |
| `geist-mono-cyrillic-ext.woff2` | 6,176 | `https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrodmgPn.woff2` | `cd8800999070b729e1cc0bf7a48da6c3ac096a044251171b9a7574b56d96d4b4` |
| `geist-mono-cyrillic.woff2` | 12,940 | `https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrMdmgPn.woff2` | `4866787fc952dbdbd591d6923d67bc21c2d894b93f34ab69d0cdf25d47bfb2df` |
| `geist-mono-latin-ext.woff2` | 14,696 | `https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrkdmgPn.woff2` | `1a189eb997c3e2ece68373e387afaec9e8617424186c4b1ab3cff7c54ba6223b` |
| `geist-mono-latin.woff2` | 23,128 | `https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrcdmg.woff2` | `684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc` |
| `geist-mono-symbols2.woff2` | 5,812 | `https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFg08vz7ehw.woff2` | `5bb66d8319ba1602bb2eb67dce8d79c2b4687be8ce183a0574433e949b3c60ad` |
| `geist-mono-vietnamese.woff2` | 7,696 | `https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrgdmgPn.woff2` | `d39b60889a94a527a7f73c7988a2d6efb6c081614aef683b0b386c02d74c2175` |
| `geist-vietnamese.woff2` | 8,004 | `https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwTGFWfOw.woff2` | `8fa40e5d248247735eb97a0bd593b8852440430600d6ba01364c31fe0abc1fe1` |
| `instrument-serif-italic-latin-ext.woff2` | 12,384 | `https://fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjgn7MsNo.woff2` | `d0014821252a8a770bf7551641572f239a8ede83d75652d84fef0c3627751baf` |
| `instrument-serif-italic-latin.woff2` | 22,128 | `https://fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjjH7M.woff2` | `5a51946dfffa82972bc98745359c46761515641fda557c25116459a9f83da4a7` |
| `instrument-serif-latin-ext.woff2` | 11,604 | `https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-6zsTjmbI.woff2` | `290e6267dd833bf5f899eba4c29ad0a9b09dbe53f6075b18af38057159e1ff20` |
| `instrument-serif-latin.woff2` | 21,032 | `https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjg.woff2` | `5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31` |

## Licence

All three families are under the SIL Open Font License, version 1.1 (https://openfontlicense.org), which allows them
to be bundled, embedded and served with the site. Each file carries its own copyright line and licence URL in its
`name` table:

- Geist: "Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)", version 1.800.
- Geist Mono: "Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)", version 1.701.
- Instrument Serif (regular and italic): "Copyright 2022 The Instrument Serif Project Authors
  (https://github.com/Instrument/instrument-serif)", version 1.000.

The files are not modified, subset or renamed inside (only the file names on disk differ), so the fonts keep their
Reserved Font Names, if any, and their licence.

## Updating

Only by fetching the same stylesheet again with a current browser's user agent, replacing the files and `../styles/fonts.css`
together, and updating the recorded stylesheet and this table in the same commit. Screenshots of Home and a pool page
before and after must be identical.
