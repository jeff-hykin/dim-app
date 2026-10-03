# dim-app

The tiny SDK for [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) apps that have a Deno backend: a
frontend and a backend that message each other, plus popups and privileged commands. No build step; import it by URL.

The app's server is this repo's [serve.js](serve.js): it serves the frontend, runs the backend module in the same
process, and bridges the two over a websocket at `dim-app/ws`, relative to the app. Desktop is not involved beyond
forwarding `/apps/<name>/` to that server.

## Frontend (browser)

```js
import { DimAppFrontend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.6.1/frontend.js"

const app = new DimAppFrontend() // connects to new URL("dim-app/ws", location.href)
app.receiveRequest((kind, payload) => { ... }) // ← backend → us
app.send("setGoal", 350) // → our backend
```

## Backend (Deno)

```js
import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.6.1/backend.js"

const app = new DimAppBackend()
const ctx = dimContext() // { dimosDir, python, zenohWebUrl, desktopUrl }
app.onReceive((kind, payload) => { ... }) // ← a frontend → us
app.send("hello", { n: 1 }) // → all of this app's open frontends
```

`dimContext()` is what Desktop passes the app's server (`--dimos-dir`, `--dimos-python`, `--zenoh-web-url`,
`--desktop-url`, or the `DIMOS_DIR`, `DIMOS_PYTHON`, `ZENOH_WEB_URL`, `DIMOS_DESKTOP_URL` environment):

- `dimosDir` — the dimos checkout Desktop uses; `python` — its venv's python
- `zenohWebUrl` — Desktop's [zenoh-web](https://github.com/jeff-hykin/zenoh-web) bridge
- `desktopUrl` — Desktop's HTTP base URL

Both halves carry a `VERSION`; the frontend sends it on connect so the backend can warn when they differ.
`sendBytes(kind, bytes, meta)` on either side sends bytes in a binary frame (no base64); the other side's handlers get
`(kind, { ...meta, bytes })`.

## Backend → page events (the convention for every app)

An app's backend pushes to its page over a websocket at the app-relative `api/events/ws`, one JSON event per text
message (e.g. `{"type":"session", ...}`); the agent drives app UIs through the backend, so every app with a backend
serves it. Not SSE: all apps share Desktop's origin and each SSE stream holds one of the browser's 6 HTTP/1.1
connections per host, so a few open apps leave the rest blank; websockets don't count toward that limit. The page side
is [events.js](events.js): `const stop = appEvents((event) => ..., { query, onOpen, onClose })`, which reconnects with
backoff (0.5 s doubling to 10 s). SDK backends call `app.publishEvent(event)` and serve.js serves the socket; apps with
their own server (Live Viewer, Map Builder) implement the same route themselves.

## Popups + privileged commands

Both `DimAppFrontend` and `DimAppBackend` instances have:

```js
app.ui.toast("saved")
if (await app.ui.confirm("Delete it?")) { ... }
const name = await app.ui.ask("New name?", { default: "Rex" }) // null if cancelled
await app.ui.askBoolean("Use the Wi-Fi NIC?")

const res = await app.sudo.run(["route", "-n", "add", "-host", "231.1.1.1", "-interface", "en0"])
// res = { exitCode, out, stdout, stderr, cancelled }
```

The frontend draws them (a plain overlay, styled by the page's `--bg`/`--fg`/`--accent` if it has them). A backend's
call is shown on every open frontend of the app and the first answer wins; with none open, it rejects. `sudo.run`
shows a password prompt with the exact command, then the server runs it with `sudo -S`; Cancel resolves with
`cancelled: true`.

## Building it for Desktop

Desktop builds every app with `nix build .#dimosApp`. This repo's flake makes that output from an SDK app:

```nix
{
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    inputs.dim-app.url = "github:jeff-hykin/dim-app/v0.6.1";
    outputs = { self, nixpkgs, dim-app }: {
        packages = dim-app.lib.forAllSystems nixpkgs (pkgs: {
            dimosApp = dim-app.lib.mkDimosApp {
                inherit pkgs;
                src = self;
                frontend = "dim/apps/my_app/frontend";
                backend = "dim/apps/my_app/main.js"; # optional: without it the frontend is served as a static app
            };
        });
    };
}
```

Pin the flake input and the import URLs to the same version. To run an app's server by hand:

```sh
deno run -A serve.js --frontend dim/apps/my_app/frontend --backend dim/apps/my_app/main.js --socket /tmp/my-app.sock
```

Licensed under the Apache License, Version 2.0.
