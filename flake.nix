{
  description = "Coordinate converter (browser) dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          emscripten
          cmake
          ninja
          git
          pkg-config
          python3
          zstd
          unzip
          curl
          sqlite
          gnused
          gnutar
          gzip
          proj
          nodejs
        ];
        shellHook = ''
          export PROJ_LIB="${pkgs.proj}/share/proj"
        '';
      };
    };
}
