// A dimos-app-server for dim-app SDK apps: serves the frontend directory on Desktop's socket, runs the backend module
// in this process, and bridges the two over a websocket at `/dim-app/ws`. An app's flake wraps it as
// bin/dimos-app-server:
//     deno run -A serve.js --frontend <dir> [--backend <main.js>] --socket <path> [Desktop's other flags]
import { serveDir } from "jsr:@std/http@1/file-server"

function flag(name) {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const frontend = flag("frontend")
const backend = flag("backend")
const socket = flag("socket")
if (!frontend || !socket) {
    console.error("usage: serve.js --frontend <dir> [--backend <main.js>] --socket <path>")
    Deno.exit(2)
}

const frontends = new Set()
// backend popups waiting on a frontend's answer: id -> { resolve, reject }
const pending = new Map()
let seq = 0

function broadcast(frame) {
    for (const ws of frontends) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(frame)
        }
    }
}

// every open frontend shows the popup; the first answer wins and the others take theirs down
function ui(method, args) {
    if (method === "toast") {
        broadcast(JSON.stringify({ __dimUi: { id: null, method, args } }))
        return Promise.resolve(true)
    }
    if (!frontends.size) {
        return Promise.reject(new Error("dim-app: none of this app's frontends is open to ask"))
    }
    const id = `b${++seq}`
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        broadcast(JSON.stringify({ __dimUi: { id, method, args } }))
    })
}

function answered({ id, result, error }) {
    const waiter = pending.get(id)
    if (!waiter) {
        return
    }
    pending.delete(id)
    broadcast(JSON.stringify({ __dimUi: { id, cancel: true } }))
    error ? waiter.reject(new Error(error)) : waiter.resolve(result)
}

function sudoResult(over) {
    return { exitCode: null, out: "", stdout: "", stderr: "", cancelled: false, ...over }
}

// the password goes to `sudo -S` on stdin, never argv
async function runSudo(args, password) {
    if (!Array.isArray(args) || !args.length || !args.every((arg) => typeof arg === "string")) {
        return sudoResult({ stderr: "sudo.run: `args` must be a non-empty array of strings" })
    }
    try {
        const child = new Deno.Command("sudo", {
            args: ["-S", "-p", "", ...args],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        })
            .spawn()
        const writer = child.stdin.getWriter()
        await writer.write(new TextEncoder().encode(`${password}\n`))
        await writer.close()
        const output = await child.output()
        const stdout = new TextDecoder().decode(output.stdout)
        const stderr = new TextDecoder().decode(output.stderr)
        return sudoResult({ exitCode: output.code, out: stdout + stderr, stdout, stderr })
    } catch (error) {
        return sudoResult({ stderr: `failed to run sudo: ${error.message}` })
    }
}

async function sudoRun({ args, title, reason }) {
    let password
    try {
        password = await ui("password", { title, reason, command: args })
    } catch (error) {
        return sudoResult({ stderr: error.message })
    }
    return password == null
        ? sudoResult({ cancelled: true, stderr: "cancelled by user" })
        : await runSudo(args, password)
}

const name = Deno.env.get("DIMOS_APP_NAME") || "app"
const env = (key) => Deno.env.get(key) ?? null
const ctx = {
    dimosDir: flag("dimos-dir") ?? env("DIMOS_DIR"),
    python: flag("dimos-python") ?? env("DIMOS_PYTHON"),
    zenohWebUrl: flag("zenoh-web-url") ?? env("ZENOH_WEB_URL"),
    desktopUrl: flag("desktop-url") ?? env("DIMOS_DESKTOP_URL"),
}
// seeded before the import, so `new DimAppBackend()` at main.js's top level finds its name, context and host
const registry = { version: "serve", current: name, registered: new Map(), ctx, host: { send: broadcast, ui, sudoRun } }
globalThis[Symbol.for("dim.app")] = registry

if (backend) {
    const mod = await import(new URL("file://" + (await Deno.realPath(backend))).href)
    // legacy apps export init(dimApp, ctx) instead of constructing their backend at the top level
    if (typeof mod.init === "function") {
        const { DimAppBackend } = await import("./backend.js")
        const dimApp = new DimAppBackend({ app: name })
        if (typeof mod.receiveRequest === "function") {
            dimApp.onRequest = mod.receiveRequest
        }
        await mod.init(dimApp, ctx)
    }
}

function bridge(request) {
    const { socket: ws, response } = Deno.upgradeWebSocket(request)
    ws.binaryType = "arraybuffer"
    ws.onopen = () => frontends.add(ws)
    ws.onclose = () => {
        frontends.delete(ws)
        if (!frontends.size) {
            for (const waiter of pending.values()) {
                waiter.reject(new Error("dim-app: the frontend closed"))
            }
            pending.clear()
        }
    }
    ws.onmessage = async ({ data }) => {
        if (typeof data === "string") {
            let msg
            try {
                msg = JSON.parse(data)
            } catch {
                return
            }
            if (msg?.__dimUiReply) {
                return answered(msg.__dimUiReply)
            }
            if (msg?.__dimSudo) {
                const { id, args, password } = msg.__dimSudo
                return ws.send(JSON.stringify({ __dimSudo: { id, result: await runSudo(args, password) } }))
            }
        }
        for (const dimApp of registry.registered.values()) {
            dimApp._dispatch(data)
        }
    }
    return response
}

try {
    await Deno.remove(socket)
} catch {
    // not there yet
}
Deno.serve(
    { path: socket, onListen: () => console.log(`serving ${frontend} on ${socket}`) },
    (request) =>
        new URL(request.url).pathname === "/dim-app/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket"
            ? bridge(request)
            : serveDir(request, { fsRoot: frontend, quiet: true }),
)
