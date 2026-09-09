# Open-source licensing and governance

Compazio is distributed as open-source software under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`) unless a file explicitly states otherwise.

The canonical project policies are:

- `LICENSE` — software license;
- `CONTRIBUTING.md` — contribution process and DCO sign-off;
- `SECURITY.md` — vulnerability reporting;
- `GOVERNANCE.md` — maintainer and decision model;
- `CODE_OF_CONDUCT.md` — community expectations;
- `TRADEMARKS.md` — rules for the Compazio name and visual identity.

## Source and infrastructure boundary

The public repository is the canonical source for the open-source core. Contributors must be able to build, test and modify that core without production secrets.

The following may remain outside the public source tree because they are credentials or operational infrastructure rather than required source code:

- code-signing private keys and certificates containing private key material;
- production service-role credentials;
- license-signing private keys;
- GitHub release tokens;
- production administration credentials;
- abuse-prevention or incident-response secrets.

Public keys, schemas, local development configuration and interfaces needed to build or test the open-source core should remain public when they are not secrets.

## Contributions

Compazio uses the Developer Certificate of Origin (DCO 1.1). Contributors sign commits with `git commit -s` to certify that they have the right to submit the contribution under the project's license.

Passing CI is necessary but does not guarantee merge. Security boundaries, backwards compatibility, architecture and long-term maintainability are part of review.

## Trademark boundary

The AGPL grants rights to the software, not to the Compazio trademark. Modified distributions must not present themselves as official Compazio releases. See `TRADEMARKS.md`.

## Dependency licensing

Third-party packages and bundled native modules retain their own licenses. Dependency/license review is part of release readiness, particularly when a dependency is redistributed inside an installer.

## Release credentials

Official publication and signing are maintainer operations. Workflows may reference GitHub Actions secrets by name, but secret values must never be committed, printed into logs or embedded in distributed application files.
