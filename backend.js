// dim-app — backend half of the shared dashboard app SDK.
//
// THE POINT: you can build a dashboard app on its own — a single file, imported
// straight from a URL (esm.sh), with no build step and a tiny dependency. When
// that app runs inside the DimOS dashboard it does NOT open its own port; every
// app shares the dashboard's single websocket and is kept apart by *namespace*.
//
// Because the dashboard AND the app both import THIS exact module URL, Deno
// dedupes it to a single module instance — one class, one shared registry — so
// there is never a "two copies of DimAppBackend" problem. The coordination
// state lives on one globalThis slot:
//
//     globalThis[Symbol.for("dim.app")] = {
//       version,                 // this SDK's version
//       current,                 // app whose backend is being imported right now
//       registered: Map,         // app name -> live DimAppBackend (with its callbacks)
//       ctx,                     // dashboard-provided context (dimos dir, python)
//     }
//
// App author writes:
//     import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@<ver>/backend.js"
//     const dimApp = new DimAppBackend()        // name comes from the registry
//     dimApp.onReceive((...args) => { ... })     // ← a frontend called us
//     dimApp.send("hello", { n: 1 })             // → all of this app's frontends
//
// Dashboard loader sets `current`/`ctx` (via the underscored helpers below) right
// before `import()`-ing each app's backend module.
//
// Like the frontend, the instance carries the desktop platform API:
// `dimApp.ui.*` (toast, confirm, ask, askBoolean) and `dimApp.sudo.run(argv)` —
// see ui.js.

import { DimUi } from "./ui.js"
import { checkDimCompat } from "./compat.js"

export const VERSION = "0.3.0"

const DIM = Symbol.for("dim.app")

/** The single shared registry (created once, shared across every importer). */
export function registry() {
    let reg = globalThis[DIM]
    if (!reg) {
        reg = globalThis[DIM] = { version: VERSION, current: null, registered: new Map(), ctx: null }
    }
    return reg
}

/** Dashboard-provided context (the dimos dir + venv python), or null. */
export function dimContext() {
    return registry().ctx
}

/** (dashboard only) Name the app whose backend is about to be imported. */
export function _setCurrentApp(name) {
    registry().current = name
}

/** (dashboard only) Provide the shared context apps read via dimContext(). */
export function _setContext(ctx) {
    registry().ctx = ctx
}

const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 5000

function defaultWsUrl(app) {
    // Backends run inside the dashboard process, so loopback is correct.
    const host = (typeof Deno !== "undefined" && Deno.env.get("DIM_DASHBOARD_HOST")) || "127.0.0.1"
    const port = (typeof Deno !== "undefined" && Deno.env.get("DIM_DASHBOARD_PORT")) || "1024"
    return `ws://${host}:${port}/ws?app=${encodeURIComponent(app)}&role=backend&v=${VERSION}`
}

export class DimAppBackend {
    /**
     * @param {{ app?: string, url?: string }} [opts]
     */
    constructor(opts = {}) {
        const reg = registry()
        const app = opts.app || reg.current
        if (!app) {
            throw new Error(
                "DimAppBackend: could not determine the app name. Construct it under the " +
                "dashboard app-loader (which sets the current app), or pass `new DimAppBackend({ app })`.",
            )
        }
        this.app = app
        this.url = opts.url || defaultWsUrl(app)

        this._handlers = []
        this.onRequest = null         // the loader may also assign module.receiveRequest
        this._ws = null
        this._open = false
        this._closed = false
        this._queue = []
        this._backoff = RECONNECT_MIN_MS

        // dim binary version, learned from the host's connect frame; compat
        // verdict (null = unknown yet, true/false once the host has announced).
        this.dimHostVersion = null
        this.dimCompatible = null

        // Desktop platform API (popups + privileged commands), reachable as
        // dimApp.ui.* and dimApp.sudo.run(). Connects lazily on first use.
        this._ui = new DimUi(() => this.app)
        this.ui = this._ui.ui
        this.sudo = this._ui.sudo

        reg.registered.set(app, this) // register ourself (+ our callbacks) in the shared registry
        this._connect()
    }

    _connect() {
        if (this._closed) {
            return
        }
        let ws
        try {
            ws = new WebSocket(this.url)
        } catch {
            this._scheduleReconnect()
            return
        }
        this._ws = ws

        ws.onopen = () => {
            this._open = true
            this._backoff = RECONNECT_MIN_MS
            const queued = this._queue
            this._queue = []
            for (const frame of queued) {
                try {
                    ws.send(frame)
                } catch {
                    this._queue.push(frame)
                }
            }
        }
        ws.onmessage = (event) => this._dispatch(event.data)
        ws.onclose = () => {
            this._open = false
            this._ws = null
            this._scheduleReconnect()
        }
        ws.onerror = () => {
            try {
                ws.close()
            } catch { /* ignore */ }
        }
    }

    _scheduleReconnect() {
        if (this._closed) {
            return
        }
        const delay = this._backoff
        this._backoff = Math.min(this._backoff * 2, RECONNECT_MAX_MS)
        setTimeout(() => this._connect(), delay)
    }

    _dispatch(raw) {
        let msg
        try {
            msg = JSON.parse(raw)
        } catch {
            return
        }
        if (msg && msg.__dimHost) {
            // the host (dim binary) announced its version — verify we support it
            this.dimHostVersion = msg.__dimHost.v ?? null
            this.dimCompatible = checkDimCompat({
                app: this.app,
                hostVersion: this.dimHostVersion,
                ui: this.ui,
                sdkVersion: VERSION,
            }).ok
            return
        }
        // version handshake from a frontend — verify the two SDK halves match.
        if (msg && msg.__dim) {
            if (msg.__dim.v && msg.__dim.v !== VERSION && !this._warnedVersion) {
                this._warnedVersion = true
                console.warn(`[dim:${this.app}] frontend SDK v${msg.__dim.v} != backend v${VERSION} — update one to match.`)
            }
            return
        }
        let args = msg && msg.data
        if (!Array.isArray(args)) {
            args = [args]
        }
        if (typeof this.onRequest === "function") {
            try {
                this.onRequest(...args)
            } catch (err) {
                console.error(`[${this.app}] receiveRequest threw:`, err)
            }
        }
        for (const fn of this._handlers) {
            try {
                fn(...args)
            } catch (err) {
                console.error(`[${this.app}] onReceive handler threw:`, err)
            }
        }
    }

    /** Register a handler for frontend → backend messages. */
    onReceive(fn) {
        this._handlers.push(fn)
        return this
    }

    /** Send a message to every connected frontend of THIS app. Auto-queues while (re)connecting. */
    send(...data) {
        if (this._closed) {
            throw new Error(`DimAppBackend(${this.app}): send() after close()`)
        }
        let frame
        try {
            frame = JSON.stringify({ data })
        } catch (err) {
            throw new Error(`DimAppBackend(${this.app}): payload is not JSON-serializable: ${err.message}`)
        }
        if (this._open && this._ws) {
            this._ws.send(frame)
        } else {
            this._queue.push(frame)
        }
    }

    /** Stop reconnecting, close the socket, and deregister. */
    close() {
        this._closed = true
        registry().registered.delete(this.app)
        try {
            this._ws?.close()
        } catch { /* ignore */ }
        this._ui.close()
        this._ws = null
        this._open = false
    }
}
