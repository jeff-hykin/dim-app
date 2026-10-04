# dim-app

The tiny SDK for [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) apps that have a Deno backend: a
frontend and a backend that message each other, plus popups and privileged commands. No build step; import it by URL.

The app's server is this repo's [serve.js](serve.js): it serves the frontend, runs the backend module in the same
process, and bridges the two over a websocket at `dim-app/ws`, relative to the app. Desktop is not involved beyond
forwarding `/apps/<name>/` to that server.

## Frontend (browser)

```js
import { DimAppFrontend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.9.3/frontend.js"

const app = new DimAppFrontend() // connects to new URL("dim-app/ws", location.href)
app.receiveRequest((kind, payload) => { ... }) // ← backend → us
app.send("setGoal", 350) // → our backend
```

## Backend (Deno)

```js
import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.9.3/backend.js"

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

## Errors → Desktop's agent

[errors.js](errors.js) sends a page's errors to Desktop's error feed (`POST /api/errors`, relative to the app:
`../../api/errors`), where a connected agent sees them (its `recent_errors` tool; the newest unacknowledged ones are in
`desktop_context`), so "it broke" comes with the error.

```js
import { captureErrors, reportError } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.9.3/errors.js"

captureErrors() // uncaught errors + unhandled rejections; DimAppFrontend calls it for you ({ captureErrors: false } opts out)
reportError("Couldn't save the map", error.stack, { level: "error" }) // handled failures worth knowing about
```

`source` defaults to the app's name (from `/apps/<name>/`). Reporting never throws and never reports its own failure; it
is throttled (the same message at most once per 10 s, at most 20 a minute). Desktop dedupes repeats into a count.

## Desktop events → apps

[desktop_events.js](desktop_events.js): `onDesktopEvent(type | "*", callback)` subscribes to Desktop's push stream
(`GET /api/events`, SSE, one JSON object per event, typed: `apps`, `endpoints`, `blueprints`, `runs`, `notification`,
`ui-settings`, …) and returns an unsubscribe function. In a page it's an `EventSource` on the same origin; in a Deno
backend it reads the stream from the Desktop URL the app server was given (`--desktop-url` / `DIMOS_DESKTOP_URL`) and
reconnects with backoff. One connection is shared by all subscriptions.

```js
// a Deno backend that hears when any app's endpoints change ({type:"endpoints", app, added, removed})
import { onDesktopEvent } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.9.3/desktop_events.js"

const off = onDesktopEvent("endpoints", ({ app, added, removed }) => {
    console.log(`${app}: +${added.length} -${removed.length} endpoints`)
})
// off() to stop
```

## Notifications → Desktop's notification center

[notify.js](notify.js) posts to Desktop's `POST /api/notifications` (an absolute path: apps share Desktop's origin under
`/apps/<name>/`). Outside Desktop it does nothing and resolves to null; it never throws.

```js
import { lowLevelAlert, notify } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.9.3/notify.js"

notify({ title: "Map saved", body: "office_2f.pgm", kind: "ok" }) // kind: ok | warn | agent | events
notify({ title: "Robot fell", body: "G1 is down", kind: "warn", sound: "urgent", actions: [["Open", "open_app:g1"]] })

// once per dip below 20 %, re-armed above 25 %
const battery = lowLevelAlert({
    low: 20,
    hysteresis: 5,
    notification: (pct) => ({ title: "Battery low", body: `${pct}%`, kind: "warn", sound: "battery" }),
})
battery(percent) // on every reading
```

`sound` is `default` (vibraphone), `urgent` (arpeggio) or `battery` (game-over drop); `icon` defaults to the app's own
icon. A Deno backend passes Desktop's URL: `notify({ ..., app: "my_app" }, { origin: dimContext().desktopUrl })`.

## Theme: Portal (dark) + Research (light)

[theme.css](theme.css) is the shared component layer, value for value from Desktop's two design docs: **Portal**
(dark: void `#05070d`, ink `#ece8f0`, one accent `#7cc8ec`, square corners everywhere, 1px hairlines, glow only on
focus / active things; Inter for UI, IBM Plex Mono for data, Michroma for small uppercase section heads) and
**Research** (light: paper `#f5f4ef`, white hairline cards with a soft shadow, accent `#293ce4`, 8–14px corners and
pills for chips / toggles / bars; Instrument Serif titles, Inter, uppercase Plex Mono micro-labels). Color is status
only (`--ok`, `--warn`); Portal has no red, so `--danger` is the warn amber there. [theme.js](theme.js) picks one from
`prefers-color-scheme` (dark → Portal, light → Research), or the app's own saved choice (per app, in
`localStorage["dim-app.theme:<app>"]`); apps keep their own theme, separate from Desktop's.

Components: `.dim-btn` (`.primary` `.ghost` `.danger` `.sm` `.lg` `.icon` `.round`, `.on` / `aria-pressed`),
`.dim-input` / `.dim-select` / `.dim-textarea`, `.dim-ask` (input + send button), `.dim-check` (`.box` / `.ring`),
`.dim-switch` (`.track`), `.dim-range`, `.dim-progress`, `.dim-tabs` + `.dim-tab` (segmented; `.dim-tabs.line` for
underline tabs), `.dim-chip` / `.dim-badge` (`.ok` `.warn` `.danger` `.solid`), `.dim-dot`, `.dim-menu` +
`.dim-menu-item`, `.dim-tooltip`, `.dim-card` / `.dim-panel` (`.glass`), `.dim-sheet` / `.dim-modal` (header, footer),
`.dim-kv`, `.dim-table`, `.dim-alert`, `.dim-toast`, and type: `.dim-title` (the app's name in its bar), `.dim-h1`,
`.dim-h2`, `.dim-h3` / `.dim-label`, `.dim-mono`. App CSS stays on the variables (`--fg`, `--muted-fg`, `--card`,
`--border`, `--primary`, `--sel`, `--radius`, `--radius-lg`, `--radius-pill`, `--sans`, `--mono`, `--display`, …):
the radius tokens are 0 in Portal, and Portal squares every corner anyway, as its doc does.

Apps vendor these files (no build step at runtime, works offline). [vendor.js](vendor.js) refreshes the dim-app files an
app already has from the version in its URL, which is how an app pins a version:

```sh
deno run -A https://raw.githubusercontent.com/jeff-hykin/dim-app/v0.9.3/vendor.js frontend/src/dim-app
```

```js
import "./theme.css" // a vendored copy, or <link rel="stylesheet" href="https://esm.sh/gh/jeff-hykin/dim-app@v0.9.3/theme.css">
import {
    initTheme,
    mountThemeToggle,
    onThemeChange,
    themeColors,
    toggleTheme,
} from "https://esm.sh/gh/jeff-hykin/dim-app@v0.9.3/theme.js"

initTheme() // <body class="science [dark]">, <html data-dim-theme="portal|research">
mountThemeToggle(document.querySelector("header")) // optional "Portal / Research" pill
onThemeChange(() => renderer.setClearColor(themeColors().sceneBg)) // canvases + 3D: --scene-bg, --scene-grid, --cat-1..4
```

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
call is shown on every open frontend of the app and the first answer wins; with none open, it rejects. `sudo.run` shows
a password prompt with the exact command, then the server runs it with `sudo -S`; Cancel resolves with
`cancelled: true`.

## Building it for Desktop

Desktop builds every app with `nix build .#dimosApp`. This repo's flake makes that output from an SDK app:

```nix
{
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    inputs.dim-app.url = "github:jeff-hykin/dim-app/v0.7.0";
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
