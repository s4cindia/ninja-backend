{ pkgs }: {
  deps = [
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