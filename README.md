# dim-app

The tiny SDK for [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) apps that have a Deno backend: a
frontend and a backend that message each other, plus popups and privileged commands. No build step; import it by URL.

The app's server is this repo's [serve.js](serve.js): it serves the frontend, runs the backend module in the same
process, and bridges the two over a websocket at `dim-app/ws`, relative to the app (the SDK's request/answer channel for
`send`, popups and `sudo`). Pushes to pages that aren't SDK calls go over zenoh (below).

## Frontend (browser)

```js
import { DimAppFrontend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.10.1/frontend.js"

const app = new DimAppFrontend() // connects to new URL("dim-app/ws", location.href)
app.receiveRequest((kind, payload) => { ... }) // ← backend → us
app.send("setGoal", 350) // → our backend
```

## Backend (Deno)

```js
import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.10.1/backend.js"

const app = new DimAppBackend()
const ctx = dimContext() // { name, url, path, dataDir, desktopUrl, zenohWebUrl, dimosDir, dimosPython, ... }
app.onReceive((kind, payload) => { ... }) // ← a frontend → us
app.send("hello", { n: 1 }) // → all of this app's open frontends
```

`dimContext()` is what Desktop passes the app's server in the `DIMOS_APP` environment variable, a JSON object (Desktop's
docs/apps.md; `readDimosApp()` from `app_env.js` reads it outside a backend too). On a Desktop from before 2026-10-05
the same fields are read from its older flags and env vars (`--desktop-url`, `DIMOS_APP_NAME`, ...).

- `name` — the name the app is installed under; `path` — where Desktop serves it (`/apps/<name>/`); `url` — that path on
  Desktop's loopback origin
- `dataDir` — the app's own writable folder
- `dimosDir` — the dimos checkout Desktop uses; `dimosPython` (also `python`) — its venv's python
- `zenohWebUrl` — Desktop's [zenoh-web](https://github.com/jeff-hykin/zenoh-web) bridge; `zenohConnect` — the zenoh
  endpoint dimos modules are on
- `desktopUrl` — Desktop's HTTP base URL; `recordingsDir` — the shared recordings folder

Both halves carry a `VERSION`; the frontend sends it on connect so the backend can warn when they differ.
`sendBytes(kind, bytes, meta)` on either side sends bytes in a binary frame (no base64); the other side's handlers get
`(kind, { ...meta, bytes })`.

## Backend → page: zenoh (the rule for every app)

Desktop's rule (its [docs/events.md](https://github.com/dimensionalOS/dimos-desktop/blob/main/docs/events.md)):
**backend → frontend is always zenoh**, delivered to the browser by Desktop's zenoh-web bridge, on **one** connection
per page; **frontend → backend is plain HTTP** (`POST`, `PUT`, …). No SSE, no websockets, no polling for changes. State
is "snapshot + live": the page `GET`s it, then applies events (or re-`GET`s when an event says it changed), and `GET`s
again when its zenoh-web connection comes back.

Keys: an app's frontend topics are `<ns>/apps/<name>/frontend/<topic…>` (`<name>` = the install name); Desktop's events
are `<ns>/desktop/events/<type>`, its jobs `<ns>/desktop/jobs/<id>`, the dimos server's `<ns>/dimos/events/<type>`.
Nobody hardcodes `<ns>`: pages get it from `GET ../../api/desktop/zenoh?app=<name>`, backends from `DIMOS_APP`
(`zenohNamespace`, `zenohPrefix`).

### Page: the one connection — [zenoh.js](zenoh.js)

```js
import { getZenoh } from "./dim-app/zenoh.js"

const zenoh = getZenoh() // the page's one connection (module singleton); app name from /apps/<name>/ in the URL
zenoh.subscribeFrontend("status", (status) => render(status)) // JSON by default; { parse: "text" | "bytes" }
zenoh.subscribeFrontend("robot/pose", draw, { delivery: "latest" }) // latest-wins (state that replaces itself)
zenoh.subscribeDesktop("apps", reloadApps) // <ns>/desktop/events/apps; "*" = every type
zenoh.subscribeDimos("launch", onLaunch) // <ns>/dimos/events/launch
zenoh.onState((state) => showLink(state)) // connecting | connected | degraded | lost
zenoh.onReconnect(reloadEverything) // back after "lost": events sent meanwhile are gone, re-GET
zenoh.subscribe("dimos/**", { delivery: "latest" }, onMessage) // any raw key, same connection (robot topics)
```

Every subscription returns its unsubscribe. Discovery and the first connect retry with backoff (0.5 s → 10 s), after
which the zenoh-web client reconnects by itself and re-opens the subscriptions. The client is vendored
([zenoh_web_client.js](zenoh_web_client.js), at the commit Desktop's bridge is built from), so nothing is fetched from
the network; an app with its own copy passes it: `getZenoh({ connect, connectOptions: { heartbeatHz: 10 } })` (the first
call's options win, so make that call early).

### Page: backend state — [backend_state.js](backend_state.js), [react.js](react.js)

```js
import { useBackendState } from "./dim-app/react.js"

const [recordings, { loading, error, refresh }] = useBackendState("recordings") // GET api/state/recordings
const [library] = useBackendState("api/library?sort=name") // key "library" (the path's last segment)
```

It `GET`s the snapshot, subscribes to `frontend/state/<key>`, re-`GET`s (debounced, 100 ms) when an event's `version` is
newer than what it has (an event without a version always counts), and re-`GET`s on reconnect; a failed `GET` keeps the
last data and sets `error`. `loading` is true until the first answer. Without React:
`watchBackendState(source, ({ data, loading, error }) => …)` → `{ refresh, stop }`.

### Page: an app's ordered event stream — [events.js](events.js)

`appEvents((event) => …, { onOpen, onClose })` subscribes to the frontend topic `events` (one key, reliable, so events
arrive in the order they were published); `onOpen` runs on connect and every reconnect (re-GET there).

### Backend: publishing — [frontend_publish.js](frontend_publish.js)

```js
import { publishFrontend, stateChanged } from "./dim-app/frontend_publish.js"

publishFrontend("status", { battery: 0.82 }) // POST <desktopUrl>/desktop/frontend/<name>/status
publishFrontend("events", { type: "saved", id }) // what the page's appEvents() hears
publishFrontend("map/png", bytes, { contentType: "image/png", ordered: false }) // bytes; unordered = sent at once
stateChanged("recordings") // {key, version} on state/recordings → useBackendState("recordings") re-GETs
```

Any language can do the same with one HTTP call to Desktop's relay, `POST /desktop/frontend/<name>/<topic…>` (body as
is, its content-type becomes the sample's encoding; ≤ 1 MiB, events should stay ≤ 64 KiB: put an id in the event and
serve the bytes over HTTP). A backend that links zenoh (Rust, C++, Python) may publish on
`DIMOS_APP.zenohPrefix + "/frontend/<topic>"` directly. The relay's topic chunks are letters, digits, `-`, `_`, `.`.
`publishFrontend` sends in order (one at a time), never throws for a failed publish (logs once, resolves to null), and
reads Desktop's URL and the app's name from `DIMOS_APP`. `DimAppBackend`'s `publishEvent(event)` is
`publishFrontend("events", event)`.

## Errors → Desktop's agent

[errors.js](errors.js) sends a page's errors to Desktop's error feed (`POST /api/errors`, relative to the app:
`../../api/errors`), where a connected agent sees them (its `recent_errors` tool; the newest unacknowledged ones are in
`desktop_context`), so "it broke" comes with the error.

```js
import { captureErrors, reportError } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.10.1/errors.js"

captureErrors() // uncaught errors + unhandled rejections; DimAppFrontend calls it for you ({ captureErrors: false } opts out)
reportError("Couldn't save the map", error.stack, { level: "error" }) // handled failures worth knowing about
```

`source` defaults to the app's name (from `/apps/<name>/`). Reporting never throws and never reports its own failure; it
is throttled (the same message at most once per 10 s, at most 20 a minute). Desktop dedupes repeats into a count.

## Desktop events → apps

[desktop_events.js](desktop_events.js): `onDesktopEvent(type | "*", callback)` → unsubscribe. In a page it is
`getZenoh().subscribeDesktop(type, callback)` (`<ns>/desktop/events/<type>`: `apps`, `endpoints`, `endpoint-stats`,
`blueprints`, `runs`, `recordings`, `notification`, `notifications`, `ui-settings`, `job`, `error`, `launcher`, …; see
Desktop's docs/events.md for each payload), on the page's one zenoh-web connection; `onDimosEvent(type, callback)` is
the dimos server's, and `onDesktopReconnect(callback)` says when to re-GET. In a Deno backend (no zenoh-web there) it
still reads Desktop's `GET /api/events` stream from `DIMOS_APP`'s `desktopUrl`, which Desktop keeps, deprecated, for one
release.

```js
import { onDesktopEvent } from "./dim-app/desktop_events.js"

const off = onDesktopEvent("endpoints", ({ app, added, removed }) => {
    console.log(`${app}: +${added.length} -${removed.length} endpoints`)
})
```

## Notifications → Desktop's notification center

[notify.js](notify.js) posts to Desktop's `POST /api/notifications` (an absolute path: apps share Desktop's origin under
`/apps/<name>/`). Outside Desktop it does nothing and resolves to null; it never throws.

```js
import { lowLevelAlert, notify } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.10.1/notify.js"

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

[theme.css](theme.css) is the shared component layer, value for value from Desktop's two design docs: **Portal** (dark:
void `#05070d`, ink `#ece8f0`, one accent `#7cc8ec`, square corners everywhere, 1px hairlines, glow only on focus /
active things; Inter for UI, IBM Plex Mono for data, Michroma for small uppercase section heads) and **Research**
(light: paper `#f5f4ef`, white hairline cards with a soft shadow, accent `#293ce4`, 8–14px corners and pills for chips /
toggles / bars; Instrument Serif titles, Inter, uppercase Plex Mono micro-labels). Color is status only (`--ok`,
`--warn`); Portal has no red, so `--danger` is the warn amber there. [theme.js](theme.js) picks one from
`prefers-color-scheme` (dark → Portal, light → Research), or the app's own saved choice (per app, in
`localStorage["dim-app.theme:<app>"]`); apps keep their own theme, separate from Desktop's.

Components: `.dim-btn` (`.primary` `.ghost` `.danger` `.sm` `.lg` `.icon` `.round`, `.on` / `aria-pressed`),
`.dim-input` / `.dim-select` / `.dim-textarea`, `.dim-ask` (input + send button), `.dim-check` (`.box` / `.ring`),
`.dim-switch` (`.track`), `.dim-range`, `.dim-progress`, `.dim-tabs` + `.dim-tab` (segmented; `.dim-tabs.line` for
underline tabs), `.dim-chip` / `.dim-badge` (`.ok` `.warn` `.danger` `.solid`), `.dim-dot`, `.dim-menu` +
`.dim-menu-item`, `.dim-tooltip`, `.dim-card` / `.dim-panel` (`.glass`), `.dim-sheet` / `.dim-modal` (header, footer),
`.dim-kv`, `.dim-table`, `.dim-alert`, `.dim-toast`, and type: `.dim-title` (the app's name in its bar), `.dim-h1`,
`.dim-h2`, `.dim-h3` / `.dim-label`, `.dim-mono`. App CSS stays on the variables (`--fg`, `--muted-fg`, `--card`,
`--border`, `--primary`, `--sel`, `--radius`, `--radius-lg`, `--radius-pill`, `--sans`, `--mono`, `--display`, …): the
radius tokens are 0 in Portal, and Portal squares every corner anyway, as its doc does.

The four faces are bundled in [fonts/](fonts) (latin subset, OFL) and declared with `font-display: block`; `initTheme()`
starts loading all of them, and `themeFontsReady()` resolves when they are in. Nothing is fetched from the network.

Apps vendor dim-app's files (no build step at runtime, works offline): `zenoh.js` needs `zenoh_web_client.js` next to
it, `backend_state.js` needs `zenoh.js`, `react.js` needs `backend_state.js`, `events.js` and `desktop_events.js` need
`zenoh.js`. [vendor.js](vendor.js) refreshes the dim-app files an app already has from the version in its URL, which is
how an app pins a version:

```sh
deno run -A https://raw.githubusercontent.com/jeff-hykin/dim-app/v0.10.1/vendor.js frontend/src/dim-app
```

```js
import "./theme.css" // a vendored copy, or <link rel="stylesheet" href="https://esm.sh/gh/jeff-hykin/dim-app@v0.10.1/theme.css">
import {
    initTheme,
    mountThemeToggle,
    onThemeChange,
    themeColors,
    toggleTheme,
} from "https://esm.sh/gh/jeff-hykin/dim-app@v0.10.1/theme.js"

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
DIMOS_APP='{"version":1,"name":"my-app","socket":"/tmp/my-app.sock"}' \
    deno run -A serve.js --frontend dim/apps/my_app/frontend --backend dim/apps/my_app/main.js
```

Licensed under the Apache License, Version 2.0.
