# Domino source availability and review terms

This repository is published for transparency, consultation and security review.
It is not offered under a single repository-wide open-source license.

## Scope and existing licenses

These terms apply only to original Domino material for which no other license
or agreement applies (the "covered material"). Rights in that material remain
with the respective copyright holders. All rights are reserved except for the
limited review permission below and rights otherwise available under applicable
law or GitHub's terms.

Existing licenses take precedence for the material they cover. In particular,
the Solidity source files in `contracts/src/` already carry MIT SPDX identifiers;
their MIT permissions remain in place. Third-party code, dependencies, data,
fonts and artwork retain their own licenses and notices. These terms do not
replace those licenses, restrict their permissions, or revoke licenses granted
for earlier versions. The presence of a separately licensed component does not
by itself license the rest of the repository under the same terms.

## Limited review permission

You may read and inspect the covered material and make local copies, build it,
run it and make local changes solely to evaluate, test or audit Domino in a
local review environment. This includes the fixture walkthrough and local test
suites documented in the repository. Preserve copyright, license and provenance
notices in those copies.

This permission does not authorize incorporating the covered material into
another product, redistributing or sublicensing it, or operating a public or
production service with it, whether commercial or noncommercial. Uses beyond
the review permission require separate permission from the relevant rights
holders, unless already permitted by another applicable license or by law.

Rights granted through [GitHub's Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#d-user-generated-content),
including viewing and forking through GitHub, are unaffected. Nothing here
limits rights or exceptions provided by applicable law. Review access does not
authorize access to private infrastructure, credentials, accounts or funds.

The covered material is provided as is, without warranties, to the extent
permitted by applicable law. Review permission is not a statement that the
software is suitable for production or has received a new audit.

## Component notices

Consult the applicable file headers, package licenses and these provenance
records before reusing any separately licensed component:

- [Backend notices](backend/THIRD_PARTY_NOTICES.md): MIT arithmetic, reference
  test sources with MIT/BUSL notices, dependencies and the GPLv3 token list.
- [Contract reference sources](contracts/test/reference/README.md): pinned
  upstream sources and their preserved license texts.
- [Font notices](app/public/licenses/fonts/README.md): SIL Open Font License 1.1.
- [Wallet artwork notices](app/public/wallets/PROVENANCE.md): upstream licenses
  and brand provenance.

This index does not replace those licenses or resolve obligations that may
apply when combining or distributing components. Historical audit artifacts
retain their recorded source notices and [sanitization provenance](docs/PUBLIC_SANITIZATION.md).
