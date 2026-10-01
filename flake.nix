{
    description = "dim-app: the SDK for dimOS Desktop apps, plus mkDimosApp for an app's `nix build .#dimosApp`";

    outputs = { self }: {
        lib = {
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];

            forAllSystems = nixpkgs: f:
                nixpkgs.lib.genAttrs self.lib.systems (system: f nixpkgs.legacyPackages.${system});

            # An app's dimosApp output. `frontend` and `backend` are paths inside `src`.
            #   no backend: the frontend directory itself (Desktop serves its index.html)
            #   a backend:  bin/dimos-app-server, serving the frontend and running the backend module (serve.js)
            mkDimosApp = { pkgs, src, frontend, backend ? null, name ? "dimos-app" }:
                if backend == null then
                    pkgs.runCommand name { } ''
                        cp -r ${src}/${frontend} $out
                        test -f $out/index.html
                    ''
                else
                    pkgs.writeShellScriptBin "dimos-app-server" ''
                        exec ${pkgs.deno}/bin/deno run -A --no-lock ${self}/serve.js \
                            --frontend ${src}/${frontend} --backend ${src}/${backend} "$@"
                    '';
        };
    };
}
