{ pkgs }: {
  deps = [
    pkgs.libsecret
    pkgs.xorg.libXtst
    pkgs.xorg.libXScrnSaver
    pkgs.libnotify
    pkgs.gtk3
    pkgs.dbus
    pkgs.pango
    pkgs.alsa-lib
    pkgs.mesa
    pkgs.libdrm
    pkgs.xorg.libXrandr
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.cups
    pkgs.at-spi2-atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
    pkgs.unzip
    pkgs.zip
    pkgs.gh
    pkgs.psmisc
    pkgs.nodejs_20
    pkgs.postgresql_15
    pkgs.poppler_utils
    pkgs.ghostscript
    pkgs.imagemagick
    pkgs.openjdk
    pkgs.pandoc
    pkgs.git
    pkgs.curl
    pkgs.jq
  ];

  env = {
    JAVA_HOME = "${pkgs.openjdk}";
    NODE_OPTIONS = "--max-old-space-size=4096";
  };
}