{
  flake-utils,
  flaky,
  nixpkgs,
  self,
  systems,
}: let
  pname = "dagny-omnifocus-plugin";

  supportedSystems = import systems;
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

    overlays.default = final: prev: {};

    lib = {};

    homeConfigurations =
      builtins.listToAttrs
      (builtins.map
        (flaky.lib.homeConfigurations.example self
          [({pkgs, ...}: {home.packages = [pkgs.${pname}];})])
        supportedSystems);
  }
  // flake-utils.lib.eachSystem supportedSystems (system: let
    pkgs = nixpkgs.legacyPackages.${system}.appendOverlays [
      flaky.overlays.default
    ];

    src = pkgs.lib.cleanSource ../..;
  in {
    packages = {
      default = self.packages.${system}.${pname};

      "${pname}" = pkgs.checkedDrv (pkgs.stdenv.mkDerivation {
        inherit pname src;

        version = "0.1.0";

        nativeBuildInputs = [pkgs.typescript pkgs.nodejs];

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
             $out/DagnySync.omnifocusjs/Resources/
          cp DagnySync.omnifocusjs/Resources/en.lproj/*.strings \
             $out/DagnySync.omnifocusjs/Resources/en.lproj/
        '';
      });
    };

    projectConfigurations =
      flaky.lib.projectConfigurations.default {inherit pkgs self;};

    devShells =
      self.projectConfigurations.${system}.devShells
      // {default = flaky.lib.devShells.default system self [] "";};
    checks = self.projectConfigurations.${system}.checks // {
      tests = pkgs.stdenv.mkDerivation {
        name = "${pname}-tests";
        inherit src;
        nativeBuildInputs = [pkgs.nodejs pkgs.typescript];
        buildPhase = ''
          export HOME=$(mktemp -d)
          ln -s ${self.packages.${system}.${pname}}/DagnySync.omnifocusjs/Resources DagnySync.omnifocusjs/Resources
          npm ci
          npx vitest run
        '';
        installPhase = "touch $out";
      };
    };
    formatter = self.projectConfigurations.${system}.formatter;
  })
