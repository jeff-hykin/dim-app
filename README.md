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
import { DimAppFrontend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.2.0/frontend.js"

const app = new DimAppFrontend()              // name auto-detected from the URL
app.receiveRequest((kind, payload) => { ... }) // ← backend → us
app.send("setGoal", 350)                       // → our backend
```

## Backend (Deno, in the dashboard process)

```js
import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.2.0/backend.js"

const app = new DimAppBackend()  // name comes from the registry the dashboard set
const ctx = dimContext()         // { Dimos, bridge, ... } provided by the dashboard
app.onReceive((kind, payload) => { ... })  // ← a frontend → us
app.send("hello", { n: 1 })                 // → all of this app's frontends
```

Both halves carry a `VERSION`; the frontend sends it on connect so the backend
can warn when the two are out of sync.

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
