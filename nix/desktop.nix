# T3 Code desktop (Electron) app, packaged from this fork's release AppImage.
# The AppImage is extracted and patched for Nix rather than run through
# appimage-run, so it starts on NixOS without nix-ld or FHS wrappers.
{
  lib,
  stdenv,
  appimageTools,
  autoPatchelfHook,
  makeWrapper,
  wrapGAppsHook3,
  alsa-lib,
  at-spi2-atk,
  cairo,
  cups,
  dbus,
  expat,
  gdk-pixbuf,
  glib,
  gtk3,
  libGL,
  libdrm,
  libgbm,
  libnotify,
  libpulseaudio,
  libsecret,
  libxkbcommon,
  libxshmfence,
  nspr,
  nss,
  pango,
  pciutils,
  systemdLibs,
  vulkan-loader,
  libx11,
  libxcomposite,
  libxdamage,
  libxext,
  libxfixes,
  libxrandr,
  libxcb,
  libxkbfile,
  version,
  src,
  relayUrl,
}:

let
  pname = "t3code-desktop";
  libexec = "$out/libexec/${pname}";
  desktopFile = "$out/share/applications/t3code.desktop";
in
stdenv.mkDerivation {
  inherit pname version;

  src = appimageTools.extract { inherit pname version src; };

  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
    wrapGAppsHook3
  ];

  # Electron runtime libraries (mirrors nixpkgs electron/binary/generic.nix).
  buildInputs = [
    alsa-lib
    at-spi2-atk
    cairo
    cups
    dbus
    expat
    gdk-pixbuf
    glib
    gtk3
    libGL
    libdrm
    libgbm
    libsecret
    libxkbcommon
    libxshmfence
    nspr
    nss
    pango
    stdenv.cc.cc
    systemdLibs
    vulkan-loader
    libx11
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxcb
    libxkbfile
  ];

  # Chromium and ANGLE dlopen these, so autoPatchelfHook cannot find them from
  # DT_NEEDED. appendRunpaths covers every ELF file, not just executables.
  appendRunpaths = map (pkg: "${lib.getLib pkg}/lib") [
    libGL
    libnotify
    libpulseaudio
    libsecret
    pciutils
    vulkan-loader
  ];

  # Bundled musl-targeted helpers are never loaded on glibc hosts.
  autoPatchelfIgnoreMissingDeps = [ "libc.musl-x86_64.so.1" "libc.musl-aarch64.so.1" ];

  dontWrapGApps = true;
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p ${libexec}
    cp -R . ${libexec}
    chmod -R u+w ${libexec}
    rm -rf ${libexec}/AppRun ${libexec}/t3code.desktop ${libexec}/t3code.png \
      ${libexec}/.DirIcon ${libexec}/usr

    install -Dm444 t3code.desktop ${desktopFile}
    # The AppImage launches through AppRun; point the entry at the wrapper.
    sed -i 's|^Exec=.*|Exec=t3code %U|' ${desktopFile}
    grep -qx 'Exec=t3code %U' ${desktopFile}
    mkdir -p $out/share/icons
    cp -R usr/share/icons/hicolor $out/share/icons/hicolor

    # Use the system Vulkan loader so it matches the host's ICDs.
    rm -f ${libexec}/libvulkan.so.1
    ln -s ${lib.getLib vulkan-loader}/lib/libvulkan.so.1 ${libexec}/

    runHook postInstall
  '';

  # Nix owns updates, so the in-app updater is turned off.
  postFixup = ''
    makeWrapper ${libexec}/t3code $out/bin/t3code \
      "''${gappsWrapperArgs[@]}" \
      --set T3CODE_DISABLE_AUTO_UPDATE 1 \
      --set-default T3CODE_RELAY_URL ${relayUrl}
  '';

  meta = {
    description = "T3 Code desktop app (LunarHUE fork)";
    homepage = "https://github.com/LunarHUE/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3code";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
