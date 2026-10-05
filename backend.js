// dim-app — backend half of the app SDK (Deno).
//
// The backend module runs inside the app's own server (dim-app's serve.js, which `mkDimosApp` builds into the app's
// `dimos-app-server`). serve.js bridges it to the app's frontends over a websocket at `dim-app/ws`; no other host is
// involved.
//
// App author writes:
//     import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@<ver>/backend.js"
//     const dimApp = new DimAppBackend()        // name comes from the registry serve.js seeded
//     dimApp.onReceive((...args) => { ... })     // ← a frontend called us
//     dimApp.send("hello", { n: 1 })             // → all of this app's frontends
//
// The app imports this module by URL and serve.js by path, so they're two module instances; they meet on one
// globalThis slot:
//
//     globalThis[Symbol.for("dim.app")] = {
//       version,                 // this SDK's version
//       current,                 // the app's name
//       registered: Map,         // app name -> live DimAppBackend
//       ctx,                     // see dimContext()
//       host,                    // serve.js: { send(frame), ui(method, args), sudoRun(payload) }
//     }
//
// `dimApp.ui.*` (toast, confirm, ask, askBoolean) and `dimApp.sudo.run(argv)` are shown by the app's open frontends.

import { packBinary, unpackBinary } from "./binary.js"
import { readDimosApp } from "./app_env.js"
import { publishFrontend } from "./frontend_publish.js"

export const VERSION = "0.11.2"

const DIM = Symbol.for("dim.app")

/** The single shared registry (created once, shared across every importer). */
export function registry() {
    let reg = globalThis[DIM]
    if (!reg) {
        reg = globalThis[DIM] = { version: VERSION, current: null, registered: new Map(), ctx: null, host: null }
    }
    return reg
}

/**
 * What Desktop passed the app's server: the DIMOS_APP JSON (`{ name, socket, url, path, dataDir, desktopUrl,
 * zenohWebUrl, zenohConnect, dimosDir, dimosPython, recordingsDir, ... }`, else read from older Desktops' flags/env),
 * plus `python` (dimosPython's old name).
 */
export function dimContext() {
    const reg = registry()
    if (!reg.ctx) {
        const app = readDimosApp()
        reg.ctx = { ...app, python: app.dimosPython }
    }
    return reg.ctx
}

function host() {
    const found = registry().host
    if (!found) {
        throw new Error("DimAppBackend: no host; run the backend under dim-app's serve.js (mkDimosApp does)")
    }
    return found
}

export class DimAppBackend {
    /**
     * @param {{ app?: string }} [opts]
     */
    constructor(opts = {}) {
        const reg = registry()
        this.app = opts.app || reg.current || dimContext().name || "app"
        this._handlers = []
        this.onRequest = null // the loader may also assign module.receiveRequest
        this._closed = false

        this.ui = {
            /** Transient toast on every open frontend. `kind` ∈ "info" | "ok" | "warn" | "error" (optional). */
            toast: (message, kind) => host().ui("toast", { message: String(message ?? ""), kind }),
            /** Yes/No dialog → boolean. */
            confirm: (message, opts = {}) => host().ui("confirm", { message: String(message ?? ""), ...opts }),
            /** Text prompt → string, or null if cancelled. Pass { default, placeholder, password }. */
            ask: (message, opts = {}) => host().ui("ask", { message: String(message ?? ""), ...opts }),
            /** Boolean prompt (yes/no wording) → boolean. */
            askBoolean: (message, opts = {}) => host().ui("askBoolean", { message: String(message ?? ""), ...opts }),
        }
        this.sudo = {
            /**
             * Run a privileged command. A frontend shows a password prompt with the exact command; nothing runs
             * until the user approves.
             * @param {string[]} args  argv, e.g. ["route","-n","add","-host","231.1.1.1","-interface","en0"]
             * @returns {Promise<{exitCode:number|null, out:string, stdout:string, stderr:string, cancelled:boolean}>}
             */
            run: (args, opts = {}) => host().sudoRun({ args, ...opts }),
        }

        reg.registered.set(this.app, this)
    }

    /** (serve.js) A frame from one of this app's frontends. */
    _dispatch(raw) {
        if (raw instanceof ArrayBuffer) {
            const unpacked = unpackBinary(raw)
            if (unpacked) {
                this._deliver(unpacked)
            }
            return
        }
        let msg
        try {
            msg = JSON.parse(raw)
        } catch {
            return
        }
        // version handshake from a frontend — verify the two SDK halves match.
        if (msg && msg.__dim) {
            if (msg.__dim.v && msg.__dim.v !== VERSION && !this._warnedVersion) {
                this._warnedVersion = true
                console.warn(
                    `[dim:${this.app}] frontend SDK v${msg.__dim.v} != backend v${VERSION} — update one to match.`,
                )
            }
            return
        }
        let args = msg && msg.data
        if (!Array.isArray(args)) {
            args = [args]
        }
        this._deliver(args)
    }

    _deliver(args) {
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

    /** Send a message to every connected frontend of THIS app (none connected: dropped). */
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
        host().send(frame)
    }

    /**
     * Send byte payloads (jpegs, point clouds, …) without base64: the bytes ride a
     * binary websocket frame untouched, `meta` rides a small JSON header. Handlers
     * on the other side receive (kind, { ...meta, bytes: Uint8Array }).
     */
    sendBytes(kind, bytes, meta = {}) {
        if (this._closed) {
            throw new Error(`DimAppBackend(${this.app}): sendBytes() after close()`)
        }
        host().send(packBinary(kind, bytes, meta))
    }

    /**
     * Push one JSON event to this app's pages: published on the frontend topic `events` through Desktop's relay
     * (frontend_publish.js), heard by events.js's appEvents on the page. Resolves to the relay's answer or null.
     */
    publishEvent(event) {
        if (this._closed) {
            throw new Error(`DimAppBackend(${this.app}): publishEvent() after close()`)
        }
        return publishFrontend("events", event)
    }

    /** Stop receiving and deregister. */
    close() {
        this._closed = true
        registry().registered.delete(this.app)
    }
}
