# The shared workspace image loads `default` for routed commands and terminals.
# Agent CLIs and gh belong to the workspace parent, not the repo toolchain.
{ pkgs }:
{
  default = pkgs.mkShell {
    packages = with pkgs; [
      bashInteractive
      nodejs_24
      # Corepack reads the pnpm version from package.json.
      (writeShellScriptBin "pnpm" ''
        exec ${nodejs_24}/bin/corepack pnpm "$@"
      '')
      # node-pty builds through node-gyp on Linux.
      python3
      gnumake
      gcc
      # native/resource-monitor
      cargo
      rustc
      rustfmt
      clippy
    ];

    # Use the repo's pinned vp/vpr after `pnpm install`, including in subdirectories.
    # Hooks must stay quiet because the workspace sources them before commands.
    shellHook = ''
      export PATH="$(git rev-parse --show-toplevel)/node_modules/.bin:$PATH"
      # Repo pods mount git metadata read-only; install hooks from the parent.
      if [ -d /workspace ] && [ "$PWD" = /workspace ]; then
        export VP_GIT_HOOKS=0
      fi
    '';
  };
}
