# Wallet artwork provenance

These are local, static brand icons for identifying detected browser wallets.
They do not add connectors, confer trust on a provider, or load a provider's
untrusted `icon` URL. Wallet names and trademarks belong to their respective
owners; inclusion does not imply endorsement. No dependencies were installed.

Retrieved 2026-09-12. SVG artwork is copied unchanged except that Brave's root
`style="background-color:white"` was removed for a transparent background.
Line endings and the final newline may be normalized. Artwork paths and colors
are unchanged. The inspected SVGs contain no scripts, event handlers, external
references, embedded images or foreign objects.

## Sources

Web3 Icons, revision `64e21e68cc6eaa36ff9d0a135ca2c809a759ccd6`:

- [rabby.svg](https://github.com/0xa3k5/web3icons/blob/64e21e68cc6eaa36ff9d0a135ca2c809a759ccd6/raw-svgs/wallets/branded/rabby.svg)
- [phantom.svg](https://github.com/0xa3k5/web3icons/blob/64e21e68cc6eaa36ff9d0a135ca2c809a759ccd6/raw-svgs/wallets/branded/phantom.svg)
- [ronin.svg](https://github.com/0xa3k5/web3icons/blob/64e21e68cc6eaa36ff9d0a135ca2c809a759ccd6/raw-svgs/wallets/branded/ronin.svg)
- [metamask.svg](https://github.com/0xa3k5/web3icons/blob/64e21e68cc6eaa36ff9d0a135ca2c809a759ccd6/raw-svgs/wallets/branded/metamask.svg)
- [MIT license](https://github.com/0xa3k5/web3icons/blob/64e21e68cc6eaa36ff9d0a135ca2c809a759ccd6/LICENCE)

RainbowKit, revision `03360ee924cfa6af13ff1d623b356bf5a170348e`:

- [brave.svg](https://github.com/rainbow-me/rainbowkit/blob/03360ee924cfa6af13ff1d623b356bf5a170348e/packages/rainbowkit/src/wallets/walletConnectors/braveWallet/braveWallet.svg)
- [magic-eden.svg](https://github.com/rainbow-me/rainbowkit/blob/03360ee924cfa6af13ff1d623b356bf5a170348e/packages/rainbowkit/src/wallets/walletConnectors/magicEdenWallet/magicEden.svg)
- [MIT license](https://github.com/rainbow-me/rainbowkit/blob/03360ee924cfa6af13ff1d623b356bf5a170348e/LICENSE)

Web3 Icons again, as published on npm: `@web3icons/core` 4.0.57 (MIT, the same
project), retrieved 2026-10-01 for the audit's item C16. Each SVG is the
package's string for it, unchanged (`dist/svgs/wallets/<variant>/<name>.svg.js`),
checked to hold no scripts, event handlers, links, images or foreign objects:

- coinbase.svg: `branded/coinbase`
- okx.svg: `background/okx` (OKX's black tile; the branded mark alone is black
  on transparent and would vanish on the dark theme)
- trust.svg: `branded/trust`
- walletconnect.svg: `branded/wallet-connect`, for the WalletConnect row

## Published identity metadata

RainbowKit's connector TypeScript files at the same pinned revision declare
these `rdns` values. They are only static artwork lookup hints, never proof of
the identity or safety of a browser-injected provider:

| Wallet | rdns | Source file under `packages/rainbowkit/src/wallets/walletConnectors/` |
| --- | --- | --- |
| Rabby | `io.rabby` | `rabbyWallet/rabbyWallet.ts` |
| Phantom | `app.phantom` | `phantomWallet/phantomWallet.ts` |
| Ronin | `com.roninchain.wallet` | `roninWallet/roninWallet.ts` |
| MetaMask | `io.metamask` | `metaMaskWallet/metaMaskWallet.ts` |
| Magic Eden | `io.magiceden.wallet` | `magicEdenWallet/magicEdenWallet.ts` |
| Brave | `com.brave.wallet` | `braveWallet/braveWallet.ts` |

Added 2026-10-01 (audit C16), as these wallets' extensions announce themselves;
not re-checked against the pinned revision above. A wrong value can only show
the generic tile, never select or trust a provider:

| Wallet | rdns |
| --- | --- |
| Coinbase Wallet | `com.coinbase.wallet` |
| OKX Wallet | `com.okex.wallet` |
| Trust Wallet | `com.trustwallet.app` |

The Robinhood Wallet's EIP-6963 rdns could not be confirmed, so it keeps the
generic tile.

## Web3 Icons license

MIT License

Copyright (c) 2024 0xa3k5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## RainbowKit license

MIT License

Copyright (c) 2024 Rainbow

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
