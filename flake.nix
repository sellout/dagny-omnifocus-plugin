{
  description = "Dagny / OmniFocus integration";

  nixConfig = {
    ## NB: This is a consequence of using `self.pkgsLib.runEmptyCommand`, which
    ##     allows us to sandbox derivations that otherwise can’t be.
    allow-import-from-derivation = true;
    ## https://github.com/NixOS/rfcs/blob/master/rfcs/0045-deprecate-url-syntax.md
    extra-experimental-features = ["no-url-literals"];
    extra-substituters = [
      "https://cache.garnix.io"
      "https://sellout.cachix.org"
    ];
    extra-trusted-public-keys = [
      "cache.garnix.io:CTFPyKSLcx5RMJKfLo5EEPUObbA78b0YQ2DTCJXqr9g="
      "sellout.cachix.org-1:v37cTpWBEycnYxSPAgSQ57Wiqd3wjljni2aC0Xry1DE="
    ];
    ## Isolate the build.
    sandbox = "relaxed";
    use-registries = false;
  };

  ## The flake isn’t a Nix expression, so it’s clearer to keep `outputs` (which
  ## is) in a separate file.
  outputs = inputs: import .config/flake/outputs.nix inputs;

  inputs = {
    ## Flaky should generally be the source of truth for its inputs.
    flaky = {
      inputs.systems.follows = "systems";
      url = "github:sellout/flaky";
    };

    flake-utils.follows = "flaky/flake-utils";
    nixpkgs.follows = "flaky/nixpkgs";

    ## This is the only system supported by OmniFocus.
    systems.url = "github:nix-systems/aarch64-darwin";
  };
}
