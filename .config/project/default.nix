### All available options for this file are listed in
### https://sellout.github.io/project-manager/options.xhtml
{
  config,
  lib,
  ...
}: {
  project = {
    name = "dagny-omnifocus-plugin";
    summary = "Dagny / OmniFocus integration";
  };

  programs.git.ignores = [
    "/DagnySync.omnifocusjs/Resources/*.js"
    "/build/"
    "/node_modules/"
  ];

  programs.vale.vocab.${config.project.name}.accept = [
    "Dagny"
    "formatters"
    "OmniFocus"
  ];

  ## There’s no intersection between the systems supported by this flake and the
  ## ones supported by Nix CI.
  ##
  ## TODO: The Nix Ci module shouldn’t try creating jobs for unsupported
  ##       systems.
  services.nix-ci.enable = lib.mkForce null;

  ## publishing
  services.github.settings.repository.topics = [];
}
