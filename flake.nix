{
  description = "T3 Code headless server for devcontainers on a self-hosted T3 Connect relay";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # Bump with each fork release. Hashes are the SRI sha256 of the release tarballs.
      version = "0.0.46-nightly.20261006.1";
      relayUrl = "https://t3connect.lunarhue.com";
      targets = {
        x86_64-linux = {
          arch = "linux-x64";
          hash = "sha256-5H841HtD63iVHK1FqjjTJaxMBKB7AakpuNECbqD/GHE=";
        };
        aarch64-linux = {
          arch = "linux-arm64";
          hash = "sha256-afVXgQNgWbvIkE2MyuwLResF0KJZod3/7iKIdUW/t1U=";
        };
      };
      forAllSystems =
        f: nixpkgs.lib.genAttrs (builtins.attrNames targets) (system: f system nixpkgs.legacyPackages.${system});
    in
    {
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
            # Bun embeds its program in the ELF; patching or stripping it breaks it.
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

          default = t3-devcontainer;
        }
      );
    };
}
