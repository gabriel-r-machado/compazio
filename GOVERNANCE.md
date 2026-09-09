# Governance

Compazio currently uses a maintainer-led governance model.

## Maintainers

The repository owner and current lead maintainer is **Gabriel Machado** (`@gabriel-r-machado`). Maintainers are responsible for release integrity, security response, repository policy and final merge decisions.

Additional maintainers may be added over time based on sustained, high-quality participation and trust.

## How decisions are made

- Small fixes and documentation changes can be decided in pull-request review.
- Product behavior changes should be discussed in an issue when the direction is not obvious.
- Long-lived architecture, persistence, security-boundary or compatibility decisions may require an ADR under `adr/`.
- Security-sensitive changes receive a higher review bar and may be held until a threat model or test coverage is adequate.
- Maintainers may reject changes that increase hidden automation, weaken local-first guarantees, expand privileges without a clear capability boundary or create maintenance cost disproportionate to user value.

## Pull requests

Passing CI is required but does not guarantee merge. Maintainers also review scope, architecture, security, backwards compatibility, test quality and long-term maintainability.

The preferred merge strategy for community pull requests is squash merge unless preserving individual commits materially improves the history.

## Releases

Official releases are cut by maintainers from reviewed repository state. Release credentials, signing material and production administration secrets are never shared through the public repository.

## Project direction

The public repository is the canonical place for open-source code, issues and contribution history. Private infrastructure may exist for signing, production administration, abuse prevention or operational secrets, but contributors must be able to build and work on the open-source core without access to those secrets.

## Changes to governance

Governance changes are made through a pull request so they remain visible and reviewable.