// dim-app — desktop UI + privileged-action client (browser AND Deno).
//
// This is the half of the SDK that talks to the desktop's `/ui` bridge: the
// desktop shell renders the popups, and a privileged command only runs after the
// user approves it in a password modal that shows the exact command.
//
// Apps don't construct this directly — every DimAppFrontend / DimAppBackend
// exposes it as `dimApp.ui` and `dimApp.sudo`:
//
//     dimApp.ui.toast("saved")
//     if (await dimApp.ui.confirm("Delete it?")) { ... }
//     const name = await dimApp.ui.ask("New name?", { default: "Rex" })  // null if cancelled
//     const res  = await dimApp.sudo.run(["route", "-n", "add", ...])
//     //  res = { exitCode, out, stdout, stderr, cancelled }
//
// The `/ui` channel is separate from the app bus (`/ws`): it correlates each
// request↔response by id so a reply goes back only to the caller.

export const UI_VERSION = "0.2.0"

function uiUrl(app) {
    const q = `role=client&app=${encodeURIComponent(app || "")}`
    // Browser: same origin as the page.
    if (typeof location !== "undefined" && location.host) {
        const proto = location.protocol === "https:" ? "wss:" : "ws:"
        return `${proto}//${location.host}/ui?${q}`
    }
    // Deno: loopback to the desktop process.
    return `ws://${desktopHostPort()}/ui?${q}`
}

/** Read an env var in Deno; undefined in a browser or without env permission. */
export function readEnv(name) {
    try {
        return globalThis.Deno?.env.get(name)
    } catch {
        return undefined
    }
}

/** "host:port" of the desktop for a Deno backend: DIM_DESKTOP_* first, then the older DIM_DASHBOARD_* names. */
export function desktopHostPort() {
    let host = readEnv("DIM_DESKTOP_HOST") || readEnv("DIM_DASHBOARD_HOST") || "127.0.0.1"
    if (host === "0.0.0.0") {
        host = "127.0.0.1"
    }
    const port = readEnv("DIM_DESKTOP_PORT") || readEnv("DIM_DASHBOARD_PORT") || "1024"
    return `${host}:${port}`
}

/**
 * Lazy, reconnecting client for the desktop `/ui` bridge. One per DimApp
 * instance; the socket is opened on first use.
 */
export class DimUi {
    /** @param {string | (() => string)} appOrGetter  the app's namespace (or a getter for it) */
    constructor(appOrGetter) {
        this._app = appOrGetter
        this._socket = null
        this._ready = null
        this._seq = 0
        this._pending = new Map()

        this.ui = {
            /** Transient toast. `kind` ∈ "info" | "ok" | "warn" | "error" (optional). */
            toast: (message, kind) => this._call("toast", { message: String(message ?? ""), kind }),
            /** Yes/No dialog → boolean. */
            confirm: (message, opts = {}) => this._call("confirm", { message: String(message ?? ""), ...opts }),
            /** Text prompt → string, or null if cancelled. Pass { default, placeholder, password }. */
            ask: (message, opts = {}) => this._call("ask", { message: String(message ?? ""), ...opts }),
            /** Boolean prompt (yes/no wording) → boolean. */
            askBoolean: (message, opts = {}) => this._call("askBoolean", { message: String(message ?? ""), ...opts }),
        }
        this.sudo = {
            /**
             * Run a privileged command. The desktop shows a password prompt with the
             * exact command; nothing runs until the user approves.
             * @param {string[]} args  argv, e.g. ["route","-n","add","-host","231.1.1.1","-interface","en0"]
             * @returns {Promise<{exitCode:number|null, out:string, stdout:string, stderr:string, cancelled:boolean}>}
             */
            run: (args, opts = {}) => this._call("sudoRun", { args, ...opts }),
        }
    }

    _appName() {
        return typeof this._app === "function" ? this._app() : this._app
    }

    _connect() {
        if (this._ready) return this._ready
        this._ready = new Promise((resolve, reject) => {
            let ws
            try {
                ws = new WebSocket(uiUrl(this._appName()))
            } catch (err) {
                this._ready = null
                reject(err)
                return
            }
            ws.onopen = () => { this._socket = ws; resolve(ws) }
            ws.onerror = () => {
                if (!this._socket) { this._ready = null; reject(new Error("dim-app: could not reach the desktop /ui service")) }
            }
            ws.onclose = () => {
                this._socket = null
                this._ready = null
                for (const p of this._pending.values()) p.reject(new Error("dim-app: /ui connection closed"))
                this._pending.clear()
            }
            ws.onmessage = (event) => {
                let msg
                try { msg = JSON.parse(event.data) } catch { return }
                const p = this._pending.get(msg.id)
                if (!p) return
                this._pending.delete(msg.id)
                if (msg.error) p.reject(new Error(msg.error))
                else p.resolve(msg.result)
            }
        })
        return this._ready
    }

    async _call(method, payload) {
        const ws = await this._connect()
        const id = "c" + (++this._seq)
        return await new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject })
            try {
                ws.send(JSON.stringify({ id, method, payload: payload || {} }))
            } catch (err) {
                this._pending.delete(id)
                reject(err)
            }
        })
    }

    /** Close the /ui socket (the app bus socket is separate). */
    close() {
        try { this._socket?.close() } catch { /* ignore */ }
        this._socket = null
        this._ready = null
    }
}
