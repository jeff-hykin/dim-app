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
// The folder can move while an app runs (Desktop writes `recordings.dir` into the shared config.yaml), so the keeping
// has a listening half, and it is built in rather than something each app wires itself:
//
//     const stop = watchRecordingsDir((dir) => { where = dir })  // now, and again every time it moves
//
// It subscribes to the one topic the gateway busts for this setting (`<ns>/dimos/events/config/recordingsDir`) — not
// the whole config — and re-asks this same endpoint, so there is still one answer to where recordings are. `eager` is
// the choice of when: eager (the default) re-asks at once and hands the callback the new folder, lazy calls back with
// `null` and leaves the round trip to the next `recordingsDir()`. Watching needs zenoh, loaded lazily by
// gateway_base.js, so an app that only asks never pulls in the zenoh-gateway client.
//
// A Deno backend has no page URL, so it passes Desktop's: `recordingsDir({ origin: dimContext().desktopUrl })`.

import { desktopBase, watchConfig } from "./gateway_base.js"

const PATH = "gateways/dimos/history/recordings"

/** The key of `GET /gateways/dimos/config` this folder is, and so the config event that busts it. */
const SETTING = "recordingsDir"

/** @type {Map<string, Promise<string>>} the endpoint's URL → the one ask */
const asked = new Map()

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
    const url = new URL(PATH, desktopBase(options.origin, "recordingsDir"))
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

/**
 * Subscribes to the gateway's config event for the recordings folder, so a long-lived app keeps a current answer
 * without asking for it again: `callback` is called with the folder now and again every time it moves. Never throws —
 * a failed ask or subscribe goes to `onError` (default: console.debug) and the last answer stands.
 * @param {((dir: string | null) => void) | null} [callback] eager: the folder; lazy: `null`, meaning "it moved, ask
 *   when you need it"
 * @param {{ origin?: string, fetch?: typeof fetch, zenoh?: any, eager?: boolean,
 *   onError?: (error: unknown) => void }} [options]
 * @returns {() => void} stop watching
 */
export function watchRecordingsDir(callback = null, options = {}) {
    const eager = options.eager ?? true
    let stopped = false
    const report = (error) => {
        if (stopped) {
            return
        }
        if (!options.onError) {
            console.debug("[dim-app] watchRecordingsDir:", error)
            return
        }
        try {
            options.onError(error)
        } catch (thrown) {
            console.error("[dim-app] watchRecordingsDir onError threw:", thrown)
        }
    }
    const hand = (dir) => {
        if (stopped || !callback) {
            return
        }
        try {
            callback(dir)
        } catch (error) {
            console.error("[dim-app] watchRecordingsDir callback threw:", error)
        }
    }
    let href = null
    try {
        href = new URL(PATH, desktopBase(options.origin, "recordingsDir")).href
    } catch (error) {
        report(error) // no page URL and no origin: nothing to watch, and recordingsDir() says the same
        return () => {}
    }
    const changed = () => {
        asked.delete(href) // the event carries no value: this endpoint is the answer
        if (!callback) {
            return
        }
        if (eager) {
            recordingsDir(options).then(hand, report)
        } else {
            hand(null)
        }
    }
    const stopWatching = watchConfig([SETTING], changed, options)
    if (callback && eager) {
        recordingsDir(options).then(hand, report)
    }
    return () => {
        stopped = true
        stopWatching()
    }
}
