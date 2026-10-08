# LunarHUE Actions policy

This fork keeps CI, Electron builds for macOS/Windows/Linux, their CLI archives,
and deployment of our T3 Connect relay. Use standard GitHub-hosted runners.
There is no Blacksmith subscription or Kubernetes/Nix runner dependency.

## Keep during upstream merges

- `ci.yml`: lint, typecheck, builds, web/server/package tests, native Rust checks,
  release script smoke tests, and the aggregate `Check` gate. It runs for PRs,
  main pushes, `ci/**` branches, and manual dispatches.
- `release.yml` and `release-desktop.yml`: daily nightly and manual preview/nightly/stable releases
  and stable version tags. Build macOS arm64/x64, Windows arm64/x64, and Linux
  arm64/x64. Preserve updater manifests, signing support, and CLI archives.
  Windows packages embed the same-architecture Linux CLI for WSL.
- `relay-cluster.yml`: test cluster adapters against PostgreSQL, build the relay
  container, and publish commit-tagged images on main/ci branch pushes or manual dispatch.
- `deploy-relay.yml`: optional Cloudflare deployment; keep disabled for our cluster.

Delete or comment out upstream additions for Discord announcements, marketing
or hosted web deployments, npm/AUR publishing, mobile EAS/store releases and
screenshots, PR preview publishing, label/vouch/size bots, Cursor webhooks,
report comments, automatic release version commits, and scheduled releases other
than the desktop nightly in `release.yml`.
Do not restore these just to resolve an upstream merge. Keep their application
code and scripts unless a separate change removes those features.

## Desktop releases

Use the Release workflow's `preview` channel to exercise packaging without
creating updater feeds. Stable and nightly channels publish updater metadata
in this fork's GitHub Releases. The desktop job explicitly sets `T3CODE_DESKTOP_UPDATE_REPOSITORY` to
`github.repository`, keeping both updater channels on `LunarHUE/t3code`. Signing secrets remain optional; unsigned builds are useful for
validation, while distribution may require platform signing credentials.

Public Connect build configuration comes from the repository variable
`T3CODE_RELAY_URL`. Set it to `https://t3connect.lunarhue.com` before distributing
builds for our deployment. OIDC issuer/client settings and the client secret are
relay runtime configuration, never client build inputs. Desktop builds do not
fetch upstream production state or client tracing credentials. Mobile builds
and OIDC mobile integration are outside this fork's deployment scope.

Manual stable releases can specify a version to bootstrap the fork. With no
version, the workflow promotes the latest nightly's commit and version.
Releases publish only after the quality and test jobs pass.

## Relay deployment

Our primary deployment is the standalone Node relay and PostgreSQL on Kubernetes.
The HCL root lives in [Infrastructure-Tofu/t3connect](https://github.com/LunarHUE/Infrastructure-Tofu/tree/master/t3connect).
The image workflow builds from `infra/relay/Dockerfile`. It does not apply cluster
changes from GitHub-hosted runners; the infrastructure repository's push-driven
deployment process applies OpenTofu with its own cluster access.

Preserve the upstream Cloudflare entrypoint and optional provider implementations
when merging. The cluster runtime supplies private endpoint, PostgreSQL inbox,
rate-limit, and scheduler adapters. Axiom and mobile push remain disabled there.

`RELAY_DEPLOY_ENABLED` gates the optional Cloudflare workflow. Leave it unset/false
for cluster hosting. The [Cloudflare guide](../infra/relay/README.md#deployment)
remains available if that deployment is needed later.

The Release workflow builds the default branch, `main`, daily at 03:17 UTC.
It skips unchanged commits and dates with an already published nightly, and
publishes prereleases tagged `nightly-YYYYMMDD`. A matching SemVer release keeps
existing desktop updaters and CLI installers working. Desktop package versions keep
the SemVer format `<next version>-nightly.<UTC date>.<workflow run>` required by
the updater. All build and publishing jobs use GitHub-hosted runners.

Dispatch Release with channel `nightly` from `main` to run it manually. Stable
and nightly builds must come from the default branch. To test an unmerged
branch, dispatch channel `preview` with that branch as the workflow ref;
preview releases have separate tags and carry no updater feed. Later stable
releases can follow upstream's three-part versions; our GitHub release feeds
remain independent of upstream.
