# LunarHUE Actions policy

This fork keeps CI, Electron builds for macOS/Windows/Linux, their CLI archives,
and deployment of our T3 Connect relay. Use standard GitHub-hosted runners.
There is no Blacksmith subscription or Kubernetes/Nix runner dependency.

## Keep during upstream merges

- `ci.yml`: lint, typecheck, builds, web/server/package tests, native Rust checks,
  release script smoke tests, and the aggregate `Check` gate. It runs for PRs,
  main pushes, `ci/**` branches, and manual dispatches.
- `release.yml` and `release-desktop.yml`: manual preview/nightly/stable releases
  and stable version tags. Build macOS arm64/x64, Windows arm64/x64, and Linux
  arm64/x64. Preserve updater manifests, signing support, and CLI archives.
  Windows packages embed the same-architecture Linux CLI for WSL.
- `deploy-relay.yml`: deploy our relay using our own production environment.

Delete or comment out upstream additions for Discord announcements, marketing
or hosted web deployments, npm/AUR publishing, mobile EAS/store releases and
screenshots, PR preview publishing, label/vouch/size bots, Cursor webhooks,
report comments, automatic release version commits, and scheduled releases.
Do not restore these just to resolve an upstream merge. Keep their application
code and scripts unless a separate change removes those features.

## Desktop releases

Use the Release workflow's `preview` channel to exercise packaging without
creating updater feeds. Stable and nightly channels publish updater metadata
in this fork's GitHub Releases. The build uses `GITHUB_REPOSITORY` as the update
repository. Signing secrets remain optional; unsigned builds are useful for
validation, while distribution may require platform signing credentials.

Public Connect build configuration comes from repository variables:
`T3CODE_RELAY_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, and
`CLERK_CLI_OAUTH_CLIENT_ID`. Configure these before distributing builds meant to
use our relay. Empty values do not configure a custom Connect service. Desktop
builds no longer fetch upstream production state or client tracing credentials.

Manual stable releases can specify a version to bootstrap the fork. With no
version, the workflow promotes the latest nightly's commit and version.
Releases publish only after the quality and test jobs pass.

## Relay deployment

The fork defaults to hosted Supabase PostgreSQL through Hyperdrive and Clerk.
Axiom and mobile push are disabled without deleting their implementations.
PlanetScale remains an optional deployment provider.

Follow the [relay deployment guide](../infra/relay/README.md#deployment) for
connection URLs, Clerk, Cloudflare token permissions, and GitHub configuration.
Disabled integrations require no credentials or cloud resources. Preserve their
upstream source during merges and retain the configuration boundaries.

`RELAY_DEPLOY_ENABLED` is a repository variable; leave it unset until deployment
credentials are ready. The workflow applies external-database migrations before
deploying Worker code. Preserve the upstream migration files when merging.
