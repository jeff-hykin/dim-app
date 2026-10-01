// A dimos-app-server for dim-app SDK apps: serves the frontend directory on Desktop's socket and runs the backend
// module in this process. An app's flake wraps it as bin/dimos-app-server:
//     deno run -A serve.js --frontend <dir> [--backend <main.js>] --socket <path> [Desktop's other flags]
// The backend registers on Desktop's /ws bus under DIM_APP_NAME, which Desktop sets to the app's name.
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

if (backend) {
    const name = Deno.env.get("DIM_APP_NAME")
    const ctx = JSON.parse(Deno.env.get("DIM_APP_CTX") || "null")
    // seeded before the import, so `new DimAppBackend()` at main.js's top level finds its name and context
    globalThis[Symbol.for("dim.app")] = { version: "serve", current: name, registered: new Map(), ctx }
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

try {
    await Deno.remove(socket)
} catch {
    // not there yet
}
Deno.serve({ path: socket, onListen: () => console.log(`serving ${frontend} on ${socket}`) }, (request) =>
    serveDir(request, { fsRoot: frontend, quiet: true }))
