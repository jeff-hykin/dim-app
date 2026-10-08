# dim-app

The tiny SDK for [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) apps that have a Deno backend: a
frontend and a backend that message each other, plus popups and privileged commands. No build step; import it by URL.

The app's server is this repo's [serve.js](source/serve.js): it serves the frontend, runs the backend module in the same
process, and bridges the two over a websocket at `dim-app/ws`, relative to the app (the SDK's request/answer channel for
`send`, popups and `sudo`). Pushes to pages that aren't SDK calls go over zenoh (below).

Layout: [mod.js](mod.js) re-exports the whole API (`import { DimApp, initTheme } from "./dim-app/mod.js"`); the files
are in [source/](source), their tests in [tests/](tests) (`deno test -A`), and [tools/vendor.js](tools/vendor.js)
vendors them into an app.

## Decoding dimos messages: the Desktop's codec endpoint

The dimos gateway (reached through Desktop) serves a codec generated from the installed dimos's own message types:
`GET /dimos/msgs.js` for pages, `GET /dimos/msgs.ts` for Deno backends. `DimApp` requires you to point at it, and the
app must declare it in its `dimos.yaml` (Desktop refuses undeclared calls):

```yaml
uses:
    "@dimos-gateway":
        - GET /msgs.js
```

```js
import { DimApp } from "./dim-app/mod.js"

// relative to the page (served at /apps/<name>/), so ../../ is Desktop's root
const app = new DimApp({ msgDecodeEndpoint: "../../dimos/msgs.js" })
app.subscribe("odom", (odom) => console.log(odom.pose.pose.position)) // already decoded
```

There is no default: an app without `msgDecodeEndpoint` throws, so every app states the endpoint it depends on.

## Frontend (browser)

```js
import { DimAppFrontend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.20.1/source/frontend.js"

const app = new DimAppFrontend() // connects to new URL("dim-app/ws", location.href)
app.receiveRequest((kind, payload) => { ... }) // ← backend → us
app.send("setGoal", 350) // → our backend
```

## Backend (Deno)

```js
import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.20.1/source/backend.js"

const app = new DimAppBackend()
const ctx = dimContext() // { name, url, path, dataDir, desktopUrl, zenohGatewayUrl, dimosDir, dimosPython, ... }
app.onReceive((kind, payload) => { ... }) // ← a frontend → us
app.send("hello", { n: 1 }) // → all of this app's open frontends
```

`dimContext()` is what Desktop passes the app's server in the `DIMOS_APP` environment variable, a JSON object (Desktop's
docs/apps.md; `readDimosApp()` from `app_env.js` reads it outside a backend too). It is the whole interface: Desktop
passes no flags or other variables.

- `name` — the name the app is installed under; `path` — where Desktop serves it (`/apps/<name>/`); `url` — that path on
  Desktop's loopback origin
- `dataDir` — the app's own writable folder
- `dimosDir` — the dimos checkout Desktop uses; `dimosPython` (also `python`) — its venv's python
- `zenohGatewayUrl` — Desktop's [zenoh-gateway](https://github.com/jeff-hykin/zenoh-gateway) ; `zenohConnect` — the zenoh
  endpoint dimos modules are on
- `desktopUrl` — Desktop's HTTP base URL; `recordingsDir` — the shared recordings folder

Both halves carry a `VERSION`; the frontend sends it on connect so the backend can warn when they differ.
`sendBytes(kind, bytes, meta)` on either side sends bytes in a binary frame (no base64); the other side's handlers get
`(kind, { ...meta, bytes })`.

## Backend → page: zenoh (the rule for every app)

Desktop's rule (its [docs/events.md](https://github.com/dimensionalOS/dimos-desktop/blob/main/docs/events.md)):
**backend → frontend is always zenoh**, delivered to the browser by Desktop's zenoh-gateway, on **one** connection
per page; **frontend → backend is plain HTTP** (`POST`, `PUT`, …). No SSE, no websockets, no polling for changes. State
is "snapshot + live": the page `GET`s it, then applies events (or re-`GET`s when an event says it changed), and `GET`s
again when its zenoh-gateway connection comes back.

Keys: an app's frontend topics are `<ns>/apps/<name>/frontend/<topic…>` (`<name>` = the install name); Desktop's events
are `<ns>/desktop/events/<type>`, its jobs `<ns>/desktop/jobs/<id>`, the dimos server's `<ns>/dimos/events/<type>`.
Nobody hardcodes `<ns>`: pages get it from `GET ../../api/desktop/zenoh?app=<name>`, backends from `DIMOS_APP`
(`zenohNamespace`, `zenohPrefix`).

### Page: dimos streams, decoded — [dim_app.js](source/dim_app.js) (start here)

```js
import { DimApp } from "./dim-app/source/dim_app.js"

// the dimos gateway's generated codec; declare GET /msgs.js under uses: "@dimos-gateway" in dimos.yaml
const app = new DimApp({ msgDecodeEndpoint: "../../dimos/msgs.js" })
app.subscribe("odom", (odom, { key, type, receivedAt }) => draw(odom.pose.pose)) // dimos/odom/*, decoded
app.subscribe("camera/image", show, { type: "sensor_msgs.Image", delivery: "reliable" }) // one type, every frame
const camera = app.subscribe("color_image", show, { maxHz: 10 }) // calling it unsubscribes; it also has .update()
await camera.update({ maxHz: 30, playoutDelay: [100, 400] }) // same channel and video track, no resubscribe
await app.publish("cmd_vel", "geometry_msgs.Twist", { linear: { x: 0.3 } }) // encoded, put on dimos/cmd_vel/<type>
const drive = await app.publisher("cmd_vel", app.msgs.geometry_msgs.Twist) // a steady stream; silent until put()
await drive.setDeadman({}) // the stop value (a zero Twist); armed only once the user drives (needs heartbeatHz)
onPress(() => drive.put({ angular: { z: 0.5 } })) // a drive: sent, and the deadman is armed on the gateway
onRelease(() => drive.stop()) // the zero Twist goes out and the deadman is disarmed: idle is silent again
```

**Never actuate without a user action.** A page must publish nothing on a command topic (cmd_vel, tele_cmd_vel, …) until
the user presses a drive control, and nothing while idle. `publisher()` enforces the deadman half of that: it opens no
channel before the first `put()`, and the deadman (which the gateway publishes when the page's heartbeat lapses, e.g. a
background tab, or the page closes or reloads) is armed only by a put of something other than its stop value, and
disarmed by `stop()` or a put of the stop value. The rest is the page's: call `put()` only from a user's input, and send
the stop only after that input (a `pointerleave` fires on hover too, so guard it with "was driving").

**Changing a running subscription.** `subscribe()` returns its unsubscribe function, which also has `.unsubscribe()` and
`.update(changes)` (zenoh-gateway ≥ 0.5.1's `Subscription.update`): the gateway applies the new options to the same
channel and video track, so a quality preset switches without a freeze or a new subscription. It takes `maxHz`,
`minQuality`, `qualityToHzTradeoff`, `bandwidthPriority`, `maxBitrate`, `minResolutionScale`, `maxResolution`,
`playoutDelay` and `encodeOptions: { quality }`; `null` puts one back to its default (a resolution change starts at a
keyframe) and anything else (`delivery`, `type`) is refused. `playoutDelay: [minMs, maxMs]` (video only, default `[0, 0]`)
lets the browser hold frames that long to smooth out jitter, trading latency for smoothness. `zenoh.subscribe()` and the
`subscribe*` helpers below return the same kind of function; when its channel is shared with other subscribers of the
same key and options, `update()` moves only this subscriber to a channel with the new options.

dimos keys topic `<topic>` of type `<pkg>.<Type>` as `dimos/<topic>/<pkg>.<Type>`, so the type comes from the key. A type
the codec doesn't know arrives as raw bytes (one warning). `msgDecodeEndpoint` is required (relative to the page or
absolute) and imported once; `app.msgs` is that module, `app.zenoh` the page's shared connection below (its `.client`
is the zenoh-gateway client). Other options go to `getZenoh()` (e.g. `connectOptions: { heartbeatHz: 5 }` for deadmen).

### Page: ROS 2 messages (CDR) — [ros.js](source/ros.js)

```js
const app = new DimApp({ msgDecodeEndpoint: "../../dimos/msgs.js", rosDistro: "jazzy" }) // humble, iron, jazzy (default), kilted, lyrical
app.subscribeKey("0/chatter/**", (msg, { type }) => log(msg.data)) // rmw_zenoh: the key names the type
app.subscribeKey("cmd_vel", show, { rosType: "geometry_msgs/msg/Twist" }) // zenoh-bridge-ros2dds: the key doesn't
const odom = await app.ros.decode("nav_msgs/msg/Odometry", bytes) // or encode(type, value) → CDR bytes
await app.ros.define("my_msgs/msg/Battery", "float32 percent\nstd_msgs/Header header") // a non-standard type, from .msg text
```

Every standard ROS 2 message (std_msgs, geometry_msgs, sensor_msgs, nav_msgs, tf2_msgs, visualization_msgs, …) decodes
with Foxglove's `@foxglove/rosmsg2-serialization@3.1.2` and `@foxglove/rosmsg-msgs-common@3.3.0` (and
`@foxglove/rosmsg@5.0.5` for `define()`), imported from esm.sh at pinned versions only when a ROS type is first used.
`subscribeKey(keyExpr, ...)` is `subscribe()` for any zenoh key: a sample is decoded as ROS CDR when its key has an
rmw_zenoh type chunk (`<domain>/<topic>/<pkg>::msg::dds_::<Type>_/<hash>`), when its encoding is CDR with a schema
(`application/cdr;sensor_msgs/msg/Image`), or when the subscription passes `rosType` (zenoh-bridge-ros2dds keys are
just the topic name); anything else goes through the dimos codec. `info.type` is then `"pkg/msg/Type"`. Types are spelled
`sensor_msgs/msg/Image`, `sensor_msgs/Image` or `sensor_msgs::msg::dds_::Image_`; bytes carry CDR's 4-byte
encapsulation header, as DDS sends them. `rosCodec()` is the same codec without a DimApp.

### Page: the one connection — [zenoh.js](source/zenoh.js)

```js
import { getZenoh } from "./dim-app/source/zenoh.js"

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
which the zenoh-gateway client reconnects by itself and re-opens the subscriptions. The client is vendored
([zenoh_gateway_client.js](source/zenoh_gateway_client.js), at the commit Desktop's gateway is built from), so nothing is fetched from
the network; an app with its own copy passes it: `getZenoh({ connect, connectOptions: { heartbeatHz: 10 } })` (the first
call's options win, so make that call early).

### Page: backend state — [backend_state.js](source/backend_state.js), [react.js](source/react.js)

```js
import { useBackendState } from "./dim-app/source/react.js"

const [recordings, { loading, error, refresh }] = useBackendState("recordings") // GET api/state/recordings
const [library] = useBackendState("api/library?sort=name") // key "library" (the path's last segment)
```

It `GET`s the snapshot, subscribes to `frontend/state/<key>`, re-`GET`s (debounced, 100 ms) when an event's `version` is
newer than what it has (an event without a version always counts), and re-`GET`s on reconnect; a failed `GET` keeps the
last data and sets `error`. `loading` is true until the first answer. Without React:
`watchBackendState(source, ({ data, loading, error }) => …)` → `{ refresh, stop }`.

### Page: an app's ordered event stream — [events.js](source/events.js)

`appEvents((event) => …, { onOpen, onClose })` subscribes to the frontend topic `events` (one key, reliable, so events
arrive in the order they were published); `onOpen` runs on connect and every reconnect (re-GET there).

### Backend: publishing — [frontend_publish.js](source/frontend_publish.js)

```js
import { publishFrontend, stateChanged } from "./dim-app/source/frontend_publish.js"

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

## Inside Desktop: insets, opening apps, first-run messages

**Insets.** On a desktop-width window Desktop's floating dock sits over the bottom of every app. The shell posts how
much (`{type: "dimos-inset", top, bottom, left, right}`, Desktop's docs/apps.md) and `initTheme()` keeps
`--dim-inset-top`, `--dim-inset-bottom`, `--dim-inset-left` and `--dim-inset-right` current on `:root` (all `0px`
outside Desktop and on a phone, where the dock has its own row; `initInsets()` alone if an app doesn't use the theme).
Anything the user has to reach (drive bars, toolbars, panels, the end of a scrolling list) stays above it;
backgrounds and 3D views can stay full-bleed:

```css
.drive-bar {
    bottom: calc(12px + var(--dim-inset-bottom));
}
.side-panel {
    bottom: var(--dim-inset-bottom);
}
.list {
    padding-bottom: var(--dim-inset-bottom);
}
```

**Opening other apps** — [desktop.js](source/desktop.js):

```js
import { appInstalled, emptyState, openApp } from "./dim-app/source/desktop.js"

await openApp("launcher", { stream: "cmd_vel" }) // the Launcher, on blueprints that drive a robot
await openApp("dim-controller", { path: "#record" }) // an app, by install name or title, at a path inside it
await openApp("appstore") // built-ins: launcher, appstore, settings, desktop
await appInstalled("dim-controller") // built-ins are always installed; false outside Desktop
```

Inside Desktop's shell the app opens in the same window; a page opened on its own under Desktop opens it in a new tab;
outside Desktop `openApp` resolves to false. For the Launcher, `params` sets its filters (`query`, `robot`, `selected`,
`stream`), passed in its link.

**First-run / empty / error messages.** Every state a first-time user can hit (nothing running, the topic the app
needs missing, no recordings, the backend down, not logged in) gets a message that says what's wrong and a button for
the next step. `emptyState()` draws it in the theme (`.dim-empty`; wrap in `.dim-empty-layer` to center it over a
canvas, above the dock); a button to an app that isn't installed becomes "Install <app> from the App Store":

```js
view.replaceChildren(emptyState({
    label: "No blueprint running",
    title: "You need to launch a blueprint with a cmd_vel topic before you can control a robot",
    body: "No robot? Turn on replay in the Launcher to drive a recorded one.",
    actions: [
        { label: "Open the Launcher", app: "launcher", params: { stream: "cmd_vel" } },
        { label: "Record with the Controller", app: "dim-controller", appTitle: "the Controller" },
        { label: "Try again", onClick: retry },
    ],
}))
```

React: `<EmptyState layer title=… actions=… />` and `useAppInstalled(id)` from [react.js](source/react.js).

## Errors → Desktop's agent

[errors.js](source/errors.js) sends a page's errors to Desktop's error feed (`POST /api/errors`, relative to the app:
`../../api/errors`), where a connected agent sees them (its `recent_errors` tool; the newest unacknowledged ones are in
`desktop_context`), so "it broke" comes with the error.

```js
import { captureErrors, reportError } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.20.1/source/errors.js"

captureErrors() // uncaught errors + unhandled rejections; DimAppFrontend calls it for you ({ captureErrors: false } opts out)
reportError("Couldn't save the map", error.stack, { level: "error" }) // handled failures worth knowing about
```

`source` defaults to the app's name (from `/apps/<name>/`). Reporting never throws and never reports its own failure; it
is throttled (the same message at most once per 10 s, at most 20 a minute). Desktop dedupes repeats into a count.

## Desktop events → apps

[desktop_events.js](source/desktop_events.js): `onDesktopEvent(type | "*", callback)` → unsubscribe. In a page it is
`getZenoh().subscribeDesktop(type, callback)` (`<ns>/desktop/events/<type>`: `apps`, `endpoints`, `endpoint-stats`,
`blueprints`, `runs`, `recordings`, `notification`, `notifications`, `ui-settings`, `job`, `error`, `launcher`, …; see
Desktop's docs/events.md for each payload), on the page's one zenoh-gateway connection; `onDimosEvent(type, callback)` is
the dimos server's, and `onDesktopReconnect(callback)` says when to re-GET. In a Deno backend (no zenoh-gateway there) it
still reads Desktop's `GET /api/events` stream from `DIMOS_APP`'s `desktopUrl`, which Desktop keeps, deprecated, for one
release.

```js
import { onDesktopEvent } from "./dim-app/source/desktop_events.js"

const off = onDesktopEvent("endpoints", ({ app, added, removed }) => {
    console.log(`${app}: +${added.length} -${removed.length} endpoints`)
})
```

## Notifications → Desktop's notification center

[notify.js](source/notify.js) posts to Desktop's `POST /api/notifications` (an absolute path: apps share Desktop's origin under
`/apps/<name>/`). Outside Desktop it does nothing and resolves to null; it never throws.

```js
import { lowLevelAlert, notify } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.20.1/source/notify.js"

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

## Shell commands (sudo too) → Desktop

[shell.js](source/shell.js) asks Desktop to run shell commands (`POST /api/desktop/shell`, Desktop's docs/shell.md). Desktop
shows them over the app with a note for each, nothing runs until the user presses Run, they run in one terminal (sudo
asks for the password once), and when one fails the user or Desktop's agent fixes it in that terminal and retries it.
It resolves when the session ends; outside Desktop it resolves to `{ status: "unavailable" }` without running anything.

```js
import { runCommand, runShell } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.20.1/source/shell.js"

const result = await runShell({
    title: "Fix LAN discovery",
    message: "A VPN took the route the Go2 probe needs.",
    commands: [
        { run: "sudo route -n add -host 231.1.1.1 -interface en0", note: "Send the probe over Wi-Fi" },
        { run: "route -n get 231.1.1.1", note: "Check the route", needsStdout: true }, // stdout/stderr come back apart
    ],
})
// result.status: succeeded | failed | cancelled; result.commands[i]: { status, exitCode, output, stdout, stderr }
const one = await runCommand("id -u", { title: "Who am I", needsStdout: true }) // { status, exitCode, stdout, ... }
```

`needsStdout` pipes the command's output through `tee`, so it sees pipes instead of a terminal (no progress bars); such
a command always runs again after a fix, so its stdout is the real one. A Deno backend passes Desktop's URL and its own
name: `runShell({ ..., app: "my_app" }, { origin: dimContext().desktopUrl })`.

## Theme: Desktop's /theme.css

All theme values live in dimOS Desktop: it serves every skin's tokens (the theme contract: `--bg --fg --muted-fg
--primary --primary-fg --ok --warn --danger --info --surface --raised --input-bg --hover --sel --border --border-strong
--hair --radius --radius-sm --radius-lg --radius-xl --radius-pill --shadow --shadow-lg --blur --sans --mono --display
--label-case --track-label`, and the rest of the names below) as `/theme.css`, Portal as `:root` and each skin as
`html[data-skin="<id>"]`. [theme.css](source/theme.css) here is only the components, written against those tokens.
[theme.js](source/theme.js) links Desktop's stylesheet (an app at `/apps/<name>/` reaches it as `../../theme.css`) and sets
`html[data-skin]` and `html[data-corners]` from what Desktop saved (`localStorage["portal.theme"]` /
`["portal.corners"]`, Desktop's origin), so an app looks like the Desktop around it in every skin — Vibeslop, Hackerman,
Research, … — and re-themes the moment Desktop changes skin or corners (the `storage` event); the skin's color-scheme
picks the light or dark structural rules (`body.science.dark`). Off Desktop, theme.css's one bundled fallback: Portal's
tokens. Apps have no theme switch of their own.

Components: `.dim-btn` (`.primary` `.ghost` `.danger` `.sm` `.lg` `.icon` `.round`, `.on` / `aria-pressed`),
`.dim-input` / `.dim-select` / `.dim-textarea`, `.dim-ask` (input + send button), `.dim-check` (`.box` / `.ring`),
`.dim-switch` (`.track`), `.dim-range`, `.dim-progress`, `.dim-tabs` + `.dim-tab` (segmented; `.dim-tabs.line` for
underline tabs), `.dim-chip` / `.dim-badge` (`.ok` `.warn` `.danger` `.solid`), `.dim-dot`, `.dim-menu` +
`.dim-menu-item`, `.dim-tooltip`, `.dim-card` / `.dim-panel` (`.glass`), `.dim-sheet` / `.dim-modal` (header, footer),
`.dim-kv`, `.dim-table`, `.dim-alert`, `.dim-toast`, and type: `.dim-title` (the app's name in its bar), `.dim-h1`,
`.dim-h2`, `.dim-h3` / `.dim-label`, `.dim-mono`. App CSS stays on the variables (`--fg`, `--muted-fg`, `--card`,
`--border`, `--primary`, `--sel`, `--radius`, `--radius-lg`, `--radius-pill`, `--sans`, `--mono`, `--display`, …): a
square skin (panel radius 0, like Portal) also squares every corner, as Portal's doc does.

The four faces are bundled in [fonts/](source/fonts) (latin subset, OFL) and declared with `font-display: block`; `initTheme()`
starts loading all of them, and `themeFontsReady()` resolves when they are in. Nothing is fetched from the network.

Apps vendor dim-app (no build step at runtime, works offline) into a `dim-app/` folder that mirrors this repo:
`dim-app/mod.js` (everything) and/or `dim-app/source/<file>` (one file and what it imports: `zenoh.js` needs
`zenoh_gateway_client.js`, `react.js` needs `backend_state.js` and `desktop.js`, …). [vendor.js](tools/vendor.js)
refreshes the files the folder already has (and brings any file they import) from the version in its URL, which is how an
app pins a version. A folder from before v0.18.0 (files at its top, `dim-app/zenoh.js`) is moved into `source/`, so its
imports become `dim-app/source/zenoh.js` (or `dim-app/mod.js`).

```sh
deno run -A https://raw.githubusercontent.com/jeff-hykin/dim-app/v0.20.1/tools/vendor.js frontend/src/dim-app --index frontend/index.html
```

`--index` also keeps [first_paint.html](source/first_paint.html) in the app's `index.html` (inserted at the top of `<head>`,
then replaced in place): Desktop's `/theme.css` and its saved skin before any CSS or JS loads (off Desktop, Portal's page
color), so an app's first frame is already in Desktop's look. `initTheme()` also posts
`{type: "dimos-ready"}` to Desktop once the themed page has painted, and Desktop fades the app's frame in.

```js
import "./theme.css" // a vendored copy, or <link rel="stylesheet" href="https://esm.sh/gh/jeff-hykin/dim-app@v0.20.1/source/theme.css">
import { initTheme, onThemeChange, themeColors } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.20.1/source/theme.js"

initTheme() // Desktop's /theme.css, <html data-skin data-corners>, <body class="science [dark]">
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
    deno run -A source/serve.js --frontend dim/apps/my_app/frontend --backend dim/apps/my_app/main.js
```

Licensed under the Apache License, Version 2.0.
