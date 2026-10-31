{
  description = "T3 Code development environment and headless release packages";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # Bump with each fork release. `hash` is the SRI sha256 of the headless release
      # tarball; `appImageHash` is the SRI sha256 of the desktop AppImage.
      version = "0.1.2";
      relayUrl = "https://t3connect.lunarhue.com";
      targets = {
        x86_64-linux = {
          arch = "linux-x64";
          hash = "sha256-cl/zDG7soJhJBf11Dz7SKlOOngUqaF7DKY89XxPtYZY=";
          appImage = "x86_64";
          appImageHash = "sha256-JssWZTHgpl5jtMROYTQbD8G7z4fymSz9y3UB0GN8SBM=";
        };
        aarch64-linux = {
          arch = "linux-arm64";
          hash = "sha256-wVjQYe7nuCZFG+4wZFrtfljegJp9SFJHhL4idOEW0CA=";
          appImage = "arm64";
          appImageHash = "sha256-69Ud1Fvg5DKmJrl0fXhhFtf+KXMkiWomYI6cHgyTs8s=";
        };
      };
      forAllSystems =
        f: nixpkgs.lib.genAttrs (builtins.attrNames targets) (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        _system: pkgs: import ./nix/devshells.nix { inherit pkgs; }
      );
      packages = forAllSystems (
        system: pkgs:
        let
          target = targets.${system};
          name = "t3-${version}-${target.arch}";
        in
        rec {
          t3 = pkgs.stdenv.mkDerivation {
            pname = "t3code-headless";
            inherit version;
            src = pkgs.fetchurl {
              url = "https://github.com/LunarHUE/t3code/releases/download/v${version}/${name}.tar.gz";
              inherit (target) hash;
            };
            sourceRoot = name;
            # The executable embeds its program; preserve those bytes when installing it.
            # The devcontainer supplies the runtime libraries.
            dontFixup = true;
            installPhase = ''
              mkdir -p $out/lib/t3 $out/bin
              cp -r ./. $out/lib/t3/
              substitute ${./nix/t3.sh} $out/bin/t3 \
                --subst-var-by shell ${pkgs.runtimeShell} \
                --subst-var-by relayUrl ${relayUrl} \
                --subst-var-by t3 $out/lib/t3/t3
              chmod +x $out/bin/t3
            '';
            meta.mainProgram = "t3";
          };

          t3-devcontainer = pkgs.writeShellApplication {
            name = "t3-devcontainer";
            runtimeInputs = [
              t3
              pkgs.jq
            ];
            text = builtins.readFile ./nix/t3-devcontainer.sh;
          };

          t3-desktop = pkgs.callPackage ./nix/desktop.nix {
            inherit version relayUrl;
            src = pkgs.fetchurl {
              url = "https://github.com/LunarHUE/t3code/releases/download/v${version}/T3-Code-${version}-${target.appImage}.AppImage";
              hash = target.appImageHash;
            };
          };

          default = t3-devcontainer;
        }
      );
    };
}
