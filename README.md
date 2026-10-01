# dim-app

The tiny SDK for building **DimOS dashboard apps**.

Write an app on its own — a single file, no build step, imported straight from a
URL. When it runs inside the dashboard it does **not** open its own port: every
app shares the dashboard's one websocket and is kept apart by *namespace*.

Because the dashboard and the app both import the **same** module URL, the
runtime dedupes it to a single class instance — no "two copies" problem. The
shared coordination state lives on one `globalThis[Symbol.for("dim.app")]` slot:
`{ version, current, registered, ctx }`.

## Frontend (browser)

```js
import { DimAppFrontend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.2/frontend.js"

const app = new DimAppFrontend()              // name auto-detected from the URL
app.receiveRequest((kind, payload) => { ... }) // ← backend → us
app.send("setGoal", 350)                       // → our backend
```

## Backend (Deno)

```js
import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.2/backend.js"

const app = new DimAppBackend()  // name comes from the registry the dashboard set
const ctx = dimContext()         // { dimosDir, python, zenohWebUrl, desktopUrl } provided by the desktop
app.onReceive((kind, payload) => { ... })  // ← a frontend → us
app.send("hello", { n: 1 })                 // → all of this app's frontends
```

`dimContext()` fields:

- `dimosDir` — the dimos checkout the desktop uses
- `python` — that checkout's venv python
- `zenohWebUrl` — the desktop's [zenoh-web](https://github.com/jeff-hykin/zenoh-web) bridge, for subscribing to / publishing on dimos streams
- `desktopUrl` — the desktop's HTTP base URL

Both halves carry a `VERSION`; the frontend sends it on connect so the backend
can warn when the two are out of sync.

## Running under the new dimOS Desktop

The new (Rust) [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) (branch `jeff/rust_desktop`) runs each backend in its own Deno
process instead of in-process. List the module as `backend: { dim_app: path/to/main.js }` in your repo's `dimos.yaml`
and nothing else changes: `new DimAppBackend()` and `dimContext()` work as before. With no registry entry, the SDK
reads the environment the Desktop sets:

- `DIM_APP_NAME` — the app's name (`custom/<pkg>/<app>`)
- `DIM_APP_CTX` — `dimContext()` as JSON
- `DIM_DESKTOP_HOST` / `DIM_DESKTOP_PORT` — where `/ws` and `/ui` live (falls back to `DIM_DASHBOARD_HOST` / `DIM_DASHBOARD_PORT`, then `127.0.0.1:1024`)

So a backend can also be started by hand for debugging:

```sh
DIM_APP_NAME=custom/my-pkg/my_app DIM_DESKTOP_PORT=7078 DIM_APP_CTX='{"dimosDir":"..."}' deno run -A main.js
```

The SDK accepts the host protocol version the new Desktop announces (`0.3.1`).

## dim binary compatibility

The pinned SDK version in your import URL (`@v0.3.2`) is the *only* thing an app
maintainer declares — and it carries the binary requirement with it. The SDK
itself knows which `dim` binary versions it works with (`SUPPORTED_DIM` in
`compat.js`), so apps never hardcode a binary range.

On connect the desktop announces its binary version; the SDK checks it against
`SUPPORTED_DIM`. If the binary is too old (or out of range), it logs a clear
error and toasts the user instead of failing in some confusing downstream way.
The verdict is on the instance:

```js
app.dimHostVersion   // e.g. "0.3.62" (null in a dev run with no dim binary)
app.dimCompatible    // true / false / null (null = host hasn't announced yet)
```

A null/unknown host version is treated as compatible — dev runs without a `dim`
binary set no version, so there's nothing to enforce.

## Desktop UI + privileged commands

Every `DimAppFrontend` / `DimAppBackend` instance also exposes the desktop
platform API — no extra import. The desktop shell renders the popups, and a
privileged command only runs after the user approves it in a password modal that
shows the exact command:

```js
app.ui.toast("saved")
if (await app.ui.confirm("Delete it?")) { ... }
const name = await app.ui.ask("New name?", { default: "Rex" })  // null if cancelled

const res = await app.sudo.run(["route", "-n", "add", "-host", "231.1.1.1", "-interface", "en0"])
// res = { exitCode, out, stdout, stderr, cancelled }
```

This rides a dedicated `/ui` channel (separate from the app bus) that correlates
each request↔response by id, so a reply goes back only to the caller.

Licensed under the Apache License, Version 2.0.
