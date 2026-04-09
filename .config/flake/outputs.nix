{
  flake-utils,
  flaky,
  nixpkgs,
  self,
  systems,
}: let
  pname = "dagny-omnifocus-plugin";

  supportedSystems = import systems;

  localPackages = pkgs: {
    "${pname}" = pkgs.checkedDrv (pkgs.stdenv.mkDerivation {
      inherit pname;
      version = "0.1.0";

      src = pkgs.lib.cleanSource ../..;

      nativeBuildInputs = [
        pkgs.nodejs
        pkgs.typescript
      ];

      buildPhase = ''
        tsc --project tsconfig.json
        node build.mjs
      '';

      installPhase = ''
        mkdir -p $out/DagnySync.omnifocusjs/Resources/en.lproj
        cp DagnySync.omnifocusjs/manifest.json $out/DagnySync.omnifocusjs/
        cp DagnySync.omnifocusjs/Resources/dagnyLib.js \
           DagnySync.omnifocusjs/Resources/configure.js \
           DagnySync.omnifocusjs/Resources/syncPull.js \
           DagnySync.omnifocusjs/Resources/syncPush.js \
           DagnySync.omnifocusjs/Resources/removeMapping.js \
           $out/DagnySync.omnifocusjs/Resources/
        cp DagnySync.omnifocusjs/Resources/en.lproj/*.strings \
           $out/DagnySync.omnifocusjs/Resources/en.lproj/
      '';
    });
  };
in
  {
    schemas = {
      inherit
        (flaky.schemas)
        overlays
        homeConfigurations
        packages
        devShells
        projectConfigurations
        checks
        formatter
        ;
    };

    overlays.default = nixpkgs.lib.composeManyExtensions [
      flaky.overlays.default
      (final: prev: localPackages final)
    ];

    lib = {};

    homeConfigurations =
      builtins.listToAttrs
      (builtins.map
        (flaky.lib.homeConfigurations.example self
          [({pkgs, ...}: {home.packages = [pkgs.${pname}];})])
        supportedSystems);

    ## This project doesn’t support any systems that Nix Ci currently does.
    nix-ci.enable = false;
  }
  // flake-utils.lib.eachSystem supportedSystems (system: let
    pkgs = nixpkgs.legacyPackages.${system}.appendOverlays [
      flaky.overlays.default
    ];
  in {
    packages =
      {
        default = self.packages.${system}.${pname};
      }
      // localPackages pkgs;

    projectConfigurations =
      flaky.lib.projectConfigurations.default {inherit pkgs self;};

    devShells =
      self.projectConfigurations.${system}.devShells
      // {default = flaky.lib.devShells.default system self [] "";};
    checks =
      self.projectConfigurations.${system}.checks
      // {
        tests = pkgs.stdenv.mkDerivation {
          name = "${pname}-tests";
          __darwinAllowLocalNetworking = true;
          src = pkgs.lib.cleanSource ../..;
          npmDeps = pkgs.fetchNpmDeps {
            src = pkgs.lib.cleanSource ../..;
            hash = "sha256-9w/2E8n4j38deHEnT1jPFnJ4OiApfXPNrivUqhktYno=";
          };
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.npmHooks.npmConfigHook
            pkgs.typescript
          ];
          buildPhase = ''
            tsc --project tsconfig.json
            npx vitest run
          '';
          installPhase = "touch $out";
        };
      };
    formatter = self.projectConfigurations.${system}.formatter;
  })
