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

The retained Alchemy stack still provisions Cloudflare, PlanetScale PostgreSQL,
and Axiom and uses Clerk. This workflow cleanup does not replace those providers
or remove the relay's runtime telemetry. Those changes belong in `infra/relay`.

Configure the `production` GitHub environment with our own values:

- Variables: `CLOUDFLARE_ACCOUNT_ID`, `PLANETSCALE_ORGANIZATION`, `AXIOM_ORG_ID`,
  `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`, `CLERK_PUBLISHABLE_KEY`, and
  `CLERK_JWT_AUDIENCE`. `RELAY_DOMAIN` can override the derived relay hostname.
- Secrets: `CLOUDFLARE_API_TOKEN`, `PLANETSCALE_API_TOKEN_ID`,
  `PLANETSCALE_API_TOKEN`, `AXIOM_TOKEN`, and `CLERK_SECRET_KEY`.
- Mobile push is off by default (`APNS_ENABLED=false`). If enabled later,
  supply the APNS variables/secrets in the workflow; FCM is optional.

Set the repository variable `RELAY_DEPLOY_ENABLED=true` when these are ready.
Until then deployment is skipped. It runs from main on relevant source changes
or manual dispatch. Leave `force` unchecked for configuration-only changes;
forcing also replaces the Postgres runtime role and its password.

`RELAY_TUNNEL_CLEANUP_MODE` and `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` are optional
production environment variables. Both default to `off`; review the upstream
cleanup runbook before enabling either. Keep the upstream nullable
`tunnel_released_at` migration with the corresponding relay/client changes.
No deployment was performed as part of this cleanup.
