// Where recordings are kept: the dimos gateway answers it (`GET /gateways/dimos/history/recordings` → `{"path": "…"}`,
// relative to the app: `../../gateways/dimos/history/recordings`).
//
//     import { recordingsDir } from "./dim-app/source/recordings.js"
//     const dir = await recordingsDir() // "/home/you/.dimos/recordings"
//
// The gateway is the only thing that knows: one resolver on the dimos side, and every launch is handed that folder
// (`--record-dir`), so what the endpoint says and what a run writes to are the same folder by construction. Before
// v0.24.0 `DIMOS_APP` carried a `recordingsDir` too; a second answer to one question is how the two drifted apart, so
// it's gone and this replaces it.
//
// The app's dimos.yaml has to declare the call or Desktop refuses it with a 403:
//
//     uses:
//         "@dimos-gateway":
//             - GET /history/recordings
//
// Asked once per Desktop and the answer kept for the life of the page (or the process), so calling it on every use is
// free; a failed ask isn't kept, and `{ fresh: true }` asks again. It **throws** when the gateway can't be reached or
// refuses — a folder path is not something to guess at, and a wrong one writes recordings where nothing looks for
// them. A page that would rather draw an empty state than fail: `await recordingsDir().catch(() => null)`.
//
// A Deno backend has no page URL, so it passes Desktop's: `recordingsDir({ origin: dimContext().desktopUrl })`.

const PATH = "gateways/dimos/history/recordings"

/** @type {Map<string, Promise<string>>} the endpoint's URL → the one ask */
const asked = new Map()

/**
 * Desktop's base URL, ending in `/`: `origin`, or this page's own (`<origin><prefix>/apps/<name>/` → `<origin><prefix>/`,
 * so an app under a path prefix asks the right place).
 */
function desktopBase(origin) {
    if (origin) {
        return origin.endsWith("/") ? origin : `${origin}/`
    }
    const href = globalThis.location?.href
    if (!href) {
        throw new Error(
            "recordingsDir: no page URL to ask from; pass { origin: dimContext().desktopUrl } (a backend's DIMOS_APP has it)",
        )
    }
    const url = new URL(href)
    const match = url.pathname.match(/^(.*?)\/apps\/[^/]+\//)
    return `${url.origin}${match ? match[1] : ""}/`
}

async function ask(url, fetchImpl) {
    const response = await fetchImpl(url.href)
    if (response.status === 403) {
        throw new Error(
            `GET ${url.pathname}: HTTP 403 — add \`GET /history/recordings\` under "@dimos-gateway" in this app's dimos.yaml uses:`,
        )
    }
    if (!response.ok) {
        throw new Error(`GET ${url.pathname}: HTTP ${response.status}`)
    }
    const body = await response.json()
    if (typeof body?.path !== "string" || !body.path) {
        throw new Error(`GET ${url.pathname}: no "path" in the answer`)
    }
    return body.path
}

/**
 * The folder recordings are written to and read from, from the dimos gateway. Asked once and kept; throws when the
 * gateway can't be reached or refuses the call (undeclared in the app's dimos.yaml: HTTP 403).
 * @param {{ origin?: string, fresh?: boolean, fetch?: typeof fetch }} [options] `origin`: Desktop's base URL (default:
 *   this page's); `fresh`: ask again instead of using the kept answer
 * @returns {Promise<string>}
 */
export async function recordingsDir(options = {}) {
    const url = new URL(PATH, desktopBase(options.origin))
    if (options.fresh) {
        asked.delete(url.href)
    }
    let pending = asked.get(url.href)
    if (!pending) {
        pending = ask(url, options.fetch ?? ((...args) => globalThis.fetch(...args)))
        pending.catch(() => asked.delete(url.href)) // a failure isn't an answer: the next call asks again
        asked.set(url.href, pending)
    }
    return await pending
}
