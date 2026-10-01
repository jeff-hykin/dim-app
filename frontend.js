// dim-app — browser (frontend) half of the shared dashboard app SDK.
//
// Mirror image of DimAppBackend. A dashboard app page does:
//
//     import { DimAppFrontend } from "https://esm.sh/gh/jeff-hykin/dim-app@<ver>/frontend.js"
//     const dimApp = new DimAppFrontend()
//     dimApp.receiveRequest((...args) => { ... })   // ← backend sent us data
//     dimApp.send("setGoal", 350)                   // → this app's backend
//
// Every app connects to the dashboard's single `/ws`, tagged with the app's name
// + role=frontend, so the broker keeps namespaces apart — apps share one port.
//
// On connect it sends a one-time version handshake so the backend can warn if the
// two SDK halves are out of sync.
//
// The instance also carries the desktop platform API: `dimApp.ui.*` (toast,
// confirm, ask, askBoolean) and `dimApp.sudo.run(argv)` — see ui.js.

import { packBinary, unpackBinary } from "./binary.js"
import { DimUi } from "./ui.js"
import { checkDimCompat } from "./compat.js"

export const VERSION = "0.3.2"

const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 5000

function detectApp() {
    if (typeof window !== "undefined" && window.DIM_APP) {
        return String(window.DIM_APP)
    }
    if (typeof document !== "undefined") {
        const meta = document.querySelector('meta[name="dim-app"]')
        if (meta?.content) {
            return meta.content
        }
    }
    const path = location.pathname
    // installed apps:  /apps/installed/<pkg>/<app>/<file...>  ->  custom/<pkg>/<app>
    let m = path.match(/^\/apps\/installed\/([^/]+)\/([^/]+)(?:\/|$)/)
    if (m) {
        return `custom/${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`
    }
    // built-in / dev apps:  /apps/<name>[/...]
    m = path.match(/^\/apps\/([^/]+)/)
    if (m) {
        return decodeURIComponent(m[1])
    }
    const parts = path.split("/").filter(Boolean)
    if (parts.length >= 2) {
        return decodeURIComponent(parts[parts.length - 2])
    }
    return parts[0] ? decodeURIComponent(parts[0]) : "app"
}

function defaultWsUrl(app) {
    const proto = location.protocol === "https:" ? "wss" : "ws"
    return `${proto}://${location.host}/ws?app=${encodeURIComponent(app)}&role=frontend&v=${VERSION}`
}

export class DimAppFrontend {
    /**
     * @param {{ app?: string, url?: string }} [opts]
     */
    constructor(opts = {}) {
        this.app = opts.app || detectApp()
        this.url = opts.url || defaultWsUrl(this.app)

        this._handlers = []
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
        ws.binaryType = "arraybuffer" // binary frames arrive as ArrayBuffer, not Blob

        ws.onopen = () => {
            this._open = true
            this._backoff = RECONNECT_MIN_MS
            // one-time version handshake so the backend can flag a mismatch
            try {
                ws.send(JSON.stringify({ __dim: { v: VERSION } }))
            } catch { /* ignore */ }
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
        if (msg && msg.__dim) {
            return // backend-side handshake echo, ignore
        }
        let args = msg && msg.data
        if (!Array.isArray(args)) {
            args = [args]
        }
        this._deliver(args)
    }

    _deliver(args) {
        for (const fn of this._handlers) {
            try {
                fn(...args)
            } catch (err) {
                console.error(`[${this.app}] receiveRequest handler threw:`, err)
            }
        }
    }

    /** Register a handler for backend → frontend messages. */
    receiveRequest(fn) {
        this._handlers.push(fn)
        return this
    }

    /**
     * Send byte payloads (jpegs, point clouds, …) without base64: the bytes ride a
     * binary websocket frame untouched, `meta` rides a small JSON header. Handlers
     * on the other side receive (kind, { ...meta, bytes: Uint8Array }).
     */
    sendBytes(kind, bytes, meta = {}) {
        if (this._closed) {
            throw new Error(`DimAppFrontend(${this.app}): sendBytes() after close()`)
        }
        const frame = packBinary(kind, bytes, meta)
        if (this._open && this._ws) {
            this._ws.send(frame)
        } else {
            this._queue.push(frame)
        }
    }

    /** Send a message to THIS app's backend. Auto-queues while (re)connecting. */
    send(...data) {
        if (this._closed) {
            throw new Error(`DimAppFrontend(${this.app}): send() after close()`)
        }
        let frame
        try {
            frame = JSON.stringify({ data })
        } catch (err) {
            throw new Error(`DimAppFrontend(${this.app}): payload is not JSON-serializable: ${err.message}`)
        }
        if (this._open && this._ws) {
            this._ws.send(frame)
        } else {
            this._queue.push(frame)
        }
    }

    /** True while the underlying socket is open. */
    get connected() {
        return this._open
    }

    close() {
        this._closed = true
        try {
            this._ws?.close()
        } catch { /* ignore */ }
        this._ui.close()
        this._ws = null
        this._open = false
    }
}
