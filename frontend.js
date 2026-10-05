// dim-app — browser (frontend) half of the app SDK.
//
// Mirror image of DimAppBackend. An app page does:
//
//     import { DimAppFrontend } from "https://esm.sh/gh/jeff-hykin/dim-app@<ver>/frontend.js"
//     const dimApp = new DimAppFrontend()
//     dimApp.receiveRequest((...args) => { ... })   // ← backend sent us data
//     dimApp.send("setGoal", 350)                   // → this app's backend
//
// It connects to the app's own server (dim-app's serve.js) at `dim-app/ws`, relative to the page, so it works
// wherever the app is mounted. On connect it sends a version handshake so the backend can warn if the two SDK halves
// are out of sync.
//
// The instance also carries `dimApp.ui.*` (toast, confirm, ask, askBoolean) and `dimApp.sudo.run(argv)`. The popups
// are rendered by this page (ui.js), for its own calls and for the backend's.

import { packBinary, unpackBinary } from "./binary.js"
import { cancelUi, showUi } from "./ui.js"
import { captureErrors } from "./errors.js"

export const VERSION = "0.10.1"

const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 5000

function detectApp() {
    const meta = document.querySelector('meta[name="dim-app"]')
    if (meta?.content) {
        return meta.content
    }
    const match = location.pathname.match(/^\/apps\/([^/]+)/)
    return match ? decodeURIComponent(match[1]) : "app"
}

function defaultWsUrl() {
    const url = new URL("dim-app/ws", location.href)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.search = `v=${VERSION}`
    return url.href
}

export class DimAppFrontend {
    /**
     * @param {{ app?: string, url?: string, captureErrors?: boolean }} [opts]
     */
    constructor(opts = {}) {
        this.app = opts.app || detectApp()
        this.url = opts.url || defaultWsUrl()
        // uncaught errors and unhandled rejections reach Desktop's error feed (errors.js); `captureErrors: false` opts out
        if (opts.captureErrors !== false) {
            captureErrors({ source: this.app })
        }

        this._handlers = []
        this._ws = null
        this._open = false
        this._closed = false
        this._queue = []
        this._backoff = RECONNECT_MIN_MS
        this._seq = 0
        this._sudoPending = new Map()

        this.ui = {
            /** Transient toast. `kind` ∈ "info" | "ok" | "warn" | "error" (optional). */
            toast: (message, kind) => showUi("toast", { message: String(message ?? ""), kind }),
            /** Yes/No dialog → boolean. */
            confirm: (message, opts = {}) => showUi("confirm", { message: String(message ?? ""), ...opts }),
            /** Text prompt → string, or null if cancelled. Pass { default, placeholder, password }. */
            ask: (message, opts = {}) => showUi("ask", { message: String(message ?? ""), ...opts }),
            /** Boolean prompt (yes/no wording) → boolean. */
            askBoolean: (message, opts = {}) => showUi("askBoolean", { message: String(message ?? ""), ...opts }),
        }
        this.sudo = {
            /**
             * Run a privileged command on the app's machine. A password prompt shows the exact command; nothing runs
             * until the user approves.
             * @param {string[]} args  argv, e.g. ["route","-n","add","-host","231.1.1.1","-interface","en0"]
             * @returns {Promise<{exitCode:number|null, out:string, stdout:string, stderr:string, cancelled:boolean}>}
             */
            run: async (args, opts = {}) => {
                const password = await showUi("password", { ...opts, command: args })
                if (password == null) {
                    return { exitCode: null, out: "", stdout: "", stderr: "cancelled by user", cancelled: true }
                }
                const id = `f${++this._seq}`
                return await new Promise((resolve) => {
                    this._sudoPending.set(id, resolve)
                    this._sendFrame(JSON.stringify({ __dimSudo: { id, args, password } }))
                })
            },
        }

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
        if (msg?.__dimUi) {
            // the backend's dimApp.ui.* / sudo password prompt: every open frontend shows it, the first answer wins
            const { id, method, args, cancel } = msg.__dimUi
            if (cancel) {
                cancelUi(id)
            } else {
                showUi(method, args, id).then(
                    (result) => id != null && this._sendFrame(JSON.stringify({ __dimUiReply: { id, result } })),
                    (error) =>
                        id != null && this._sendFrame(JSON.stringify({ __dimUiReply: { id, error: error.message } })),
                )
            }
            return
        }
        if (msg?.__dimSudo) {
            this._sudoPending.get(msg.__dimSudo.id)?.(msg.__dimSudo.result)
            this._sudoPending.delete(msg.__dimSudo.id)
            return
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

    _sendFrame(frame) {
        if (this._open && this._ws) {
            this._ws.send(frame)
        } else {
            this._queue.push(frame)
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
        this._sendFrame(packBinary(kind, bytes, meta))
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
        this._sendFrame(frame)
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
        this._ws = null
        this._open = false
    }
}
