# Dev container

> For maintainers. Using T3 Code? See [docs/user](../user/).

The devcontainer follows [LunarHUE/workspace-config](https://github.com/LunarHUE/workspace-config)'s repo pod pattern. The shared `ghcr.io/lunarhue/devcontainer-base:main` image provides Nix and loads the default dev shell from this repo's flake. `nix/devshells.nix` supplies Node 24, pnpm through Corepack, Python, the C/C++ build tools needed by node-pty, and Rust for the resource monitor. `flake.lock` pins the toolchain.

## Starting locally

The shared image is private and currently supports Linux x86-64. Authenticate with `docker login ghcr.io` before choosing **Reopen in Container** in VS Code. The checkout mounts at `/workspace`, and the container runs as `coder`. Container creation warms the Nix environment; it does not install project dependencies.

In the container terminal, run:

```bash
pnpm install --frozen-lockfile
vp run --filter @t3tools/desktop ensure:electron
vp run dev
```

Corepack uses the pnpm version in `package.json`. Installing dependencies makes the repo's pinned `vp` and `vpr` available on PATH. No global Vite+ installer is needed. Use a separate checkout for container work if the host also installs dependencies, since native modules differ by platform.

Open the pairing URL printed by the dev runner through the forwarded web port. The default ports are 5733 for web and 13773 for the server; use the actual ports printed by the runner if they differ. For a browser Codespace with a different forwarded origin, set `T3CODE_DEV_ALLOWED_ORIGINS` to that origin if authentication rejects it. Codespaces also needs pull access to the private image.

## Workspace pods

Coder provisions the repo pod separately; `.devcontainer/devcontainer.json` describes the equivalent local setup. Both load `devShells.default`. `.workspace/shims` lists commands routed from the workspace parent to this repo's pod. Git, GitHub CLI, and agent runtimes belong to the parent. Run the same dependency installation there through the routed `pnpm` command.

The release packages `t3` and `t3-devcontainer` remain separate flake outputs. They are not installed in the repo's dev shell.

## State and caching

The local devcontainer sets `T3CODE_HOME` to `/workspace/.t3`. Keep test data isolated there; copy data in rather than pointing a dev server at shared state. Coder does not apply the devcontainer's environment variables, so use the dev runner's worktree default or an explicit isolated `--home-dir` there.

A named volume preserves `/nix` across local container rebuilds. Dependencies live in the checkout; the old pnpm and node_modules volumes are no longer mounted. Rebuilding the container does not reinstall dependencies automatically. Run `pnpm install --frozen-lockfile` after dependency changes.

## Verification and limits

Run focused `vp test run <files>`, `vp lint <files>`, package typechecks, and resource-monitor Cargo commands inside the dev environment. Windowed Electron needs a display, and native mobile builds need their platform SDKs. Neither is provisioned by this setup. `vp run dev --share` additionally needs Tailscale and a tailnet.
