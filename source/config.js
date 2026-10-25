// The shared dimos config, from the dimos gateway, kept honest by the gateway's `config` event:
// `GET /gateways/dimos/config` → `{"path": "<$DIMOS_HOME/config.yaml>", "recordingsDir": "<dir>"}` (relative to the
// app: `../../gateways/dimos/config`).
//
//     import { sharedConfig, watchSharedConfig } from "./dim-app/source/config.js"
//     const config = await sharedConfig()                        // { path: "…/.dimos/config.yaml", recordingsDir: "…" }
//     const stop = watchSharedConfig((config) => render(config))  // now, and again every time it changes
//
// The gateway is the source of truth: it resolves `$DIMOS_HOME/config.yaml` the same way every dimos process does
// (`dimos.utils.shared_config`), so what it answers and what a `dimos run` in a terminal uses are the same settings.
// Nothing here is a blocking read: the answer is asked for once per endpoint and kept, so reading it on every use is
// free.
//
// Staying fresh is the gateway's half: it watches the file and publishes `{"type": "config", "setting": "<setting>"}`
// on `<ns>/dimos/events/config/<setting>` when the answer it would give for that setting moves — one topic per
// setting, so an app wakes for the one it reads and not for the rest of the file, and a bust signal with no value in
// it, so a listener's cache and the event can never say different things.
//
// Both halves are here, because apps want different ones:
//
//   - `sharedConfig()` — an invalidated cache. A `config` event marks it stale; the next read asks again. An app that
//     reads the config where it needs it (and doesn't draw it) wants only this, and never has to re-ask.
//   - `watchSharedConfig(callback)` — snapshot + live, the rule for everything in Desktop: the callback is called with
//     the config now, and again after every change. An app that *shows* a setting wants this instead of polling.
//
// When the re-ask happens is the one option, not two functions: `watchSharedConfig(cb)` is **eager** (a change is
// re-asked at once and the callback gets the new config), and `watchSharedConfig(cb, { eager: false })` is **lazy**
// (the change only marks the kept answer stale, the callback gets `null`, and the round trip is paid by the next
// `sharedConfig()` — which an app that has stopped caring never makes). `{ settings: ["recordingsDir"] }` narrows the
// subscription to the settings the app actually reads.
//
// `watchSharedConfig()` with no callback is the same subscription and nothing else: it keeps the cache honest for the
// `sharedConfig()` calls elsewhere in the app. **A cache nobody watches is never invalidated** — with no watcher
// running, `sharedConfig()` keeps its first answer until `{ fresh: true }`, since the only thing that knows it changed
// is the event.
//
// The live half needs the page's zenoh-gateway connection, so it is opt-in by that one call: there is no top-level
// `import` of zenoh.js here — gateway_base.js loads it lazily. Where there is no zenoh-gateway at all (a Deno
// backend), subscribing fails, `onError` says so, and the cache is left as a plain cache; a backend that has to be
// sure asks with `{ fresh: true }`.
//
// Failure: a `path` is not something to guess at (the same reasoning as recordingsDir(), for the same kind of answer),
// so with no answer at all it **throws**. Once there is one, a failed re-ask does not take it away: the last answer
// stands, stale, and the call after that asks again — a gateway blip shouldn't turn a working app into a broken one.
// `sharedConfig({ fresh: true })` is the strict read that throws instead, which is what to use right before writing
// somewhere the config names, when a path that has since moved is worse than no answer.
//
// The app's dimos.yaml has to declare both or Desktop refuses them with a 403:
//
//     uses:
//         "@dimos-gateway":
//             - GET /config
//         "@zenoh-gateway": ">=0.5.1" # watchSharedConfig only; sharedConfig() alone needs no zenoh
//
// `recordingsDir()` (recordings.js) stays what it was: `GET /history/recordings` is still the one answer to where
// recordings are, and `sharedConfig().recordingsDir` is that same resolved directory. An app already asking for the
// config doesn't need `recordingsDir()` as well; an app that only wants the folder doesn't need to declare `GET /config`
// to get it.
//
// A Deno backend has no page URL, so it passes Desktop's: `sharedConfig({ origin: dimContext().desktopUrl })`.

import { CONFIG_EVENT, desktopBase, watchConfig } from "./gateway_base.js"

const PATH = "gateways/dimos/config"

export { CONFIG_EVENT }

/**
 * @typedef {{ path: string, recordingsDir: string }} SharedConfig the gateway's answer, as it sends it
 * @typedef {{ answer: SharedConfig | null, pending: Promise<SharedConfig> | null, stale: boolean }} Entry
 */

/** @type {Map<string, Entry>} the endpoint's URL → the last answer and whether an event has busted it */
const known = new Map()

async function ask(url, fetchImpl) {
    const response = await fetchImpl(url.href)
    if (response.status === 403) {
        throw new Error(
            `GET ${url.pathname}: HTTP 403 — add \`GET /config\` under "@dimos-gateway" in this app's dimos.yaml uses:`,
        )
    }
    if (!response.ok) {
        throw new Error(`GET ${url.pathname}: HTTP ${response.status}`)
    }
    const body = await response.json()
    if (typeof body?.path !== "string" || !body.path) {
        throw new Error(`GET ${url.pathname}: no "path" in the answer`)
    }
    return body
}

/** @returns {Entry} */
function entryFor(href) {
    let entry = known.get(href)
    if (!entry) {
        entry = { answer: null, pending: null, stale: false }
        known.set(href, entry)
    }
    return entry
}

/** One ask at a time per endpoint: everyone waiting shares it, and the answer replaces what was kept. */
function reask(entry, url, fetchImpl) {
    if (!entry.pending) {
        const pending = ask(url, fetchImpl)
        entry.pending = pending
        pending.then(
            (answer) => {
                if (entry.pending !== pending) {
                    return // a bust landed while this was in flight: its answer is already out of date
                }
                entry.answer = answer
                entry.stale = false
            },
            () => {}, // a failure isn't an answer: whatever was kept stays, still stale
        ).finally(() => {
            if (entry.pending === pending) {
                entry.pending = null
            }
        })
    }
    return entry.pending
}

/** The `config` event (and a reconnect, which means events were missed): the next read asks again. */
function bust(entry) {
    entry.stale = true
    entry.pending = null
}

/**
 * The shared dimos config from the gateway (`GET /gateways/dimos/config`): its `path` and `recordingsDir`. Asked once
 * and kept; a `config` event (while something is watching) makes the next call ask again. Throws when there is no
 * answer yet and the gateway can't be reached or refuses the call (undeclared in the app's dimos.yaml: HTTP 403); once
 * there is one, a failed re-ask leaves it standing instead, stale. `{ fresh: true }` asks again and throws on failure.
 * @param {{ origin?: string, fresh?: boolean, fetch?: typeof fetch }} [options] `origin`: Desktop's base URL (default:
 *   this page's); `fresh`: ask again, and fail rather than hand back a kept answer
 * @returns {Promise<SharedConfig>}
 */
export async function sharedConfig(options = {}) {
    const url = new URL(PATH, desktopBase(options.origin, "sharedConfig"))
    const entry = entryFor(url.href)
    const fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args))
    if (options.fresh) {
        bust(entry)
        return await reask(entry, url, fetchImpl)
    }
    if (entry.answer && !entry.stale) {
        return entry.answer
    }
    try {
        return await reask(entry, url, fetchImpl)
    } catch (error) {
        if (!entry.answer) {
            throw error
        }
        console.debug("[dim-app] sharedConfig: asking again failed; the last answer stands (stale):", error)
        return entry.answer
    }
}

/**
 * Subscribes to the gateway's `config` event so the config stays current: with `callback`, it's called with the config
 * now and again after every change (snapshot + live); with none, the subscription only busts `sharedConfig()`'s cache.
 * Never throws — a failed ask or subscribe goes to `onError` (default: console.debug) and the last answer stands.
 *
 * `eager` is when the re-ask happens, and the only difference between the two shapes an app might want. Eager (the
 * default) re-asks the moment the gateway says a setting moved, so the callback gets the new config and a
 * `sharedConfig()` elsewhere is already free. Lazy marks the kept answer stale and calls back with `null` instead: the
 * round trip is paid by the next `sharedConfig()`, so an app that has navigated away from the setting never pays it.
 * @param {((config: SharedConfig | null) => void) | null} [callback] eager: the config; lazy: `null`, meaning "it
 *   changed, read it when you need it"
 * @param {{ origin?: string, fetch?: typeof fetch, zenoh?: any, eager?: boolean, settings?: string[],
 *   onError?: (error: unknown) => void }} [options] `zenoh`: an AppZenoh to subscribe on (default: the page's one
 *   connection, loaded lazily from zenoh.js); `settings`: the keys of the answer to listen for (default: all of them)
 * @returns {() => void} stop watching
 */
export function watchSharedConfig(callback = null, options = {}) {
    const eager = options.eager ?? true
    let stopped = false
    const report = (error) => {
        if (stopped) {
            return
        }
        if (!options.onError) {
            console.debug("[dim-app] watchSharedConfig:", error)
            return
        }
        try {
            options.onError(error)
        } catch (thrown) {
            console.error("[dim-app] watchSharedConfig onError threw:", thrown)
        }
    }
    const hand = (config) => {
        if (stopped || !callback) {
            return
        }
        try {
            callback(config)
        } catch (error) {
            console.error("[dim-app] watchSharedConfig callback threw:", error)
        }
    }
    const deliver = (promise) => promise.then(hand, report)
    let href = null
    try {
        href = new URL(PATH, desktopBase(options.origin, "sharedConfig")).href
    } catch (error) {
        report(error) // no page URL and no origin: nothing to watch, and sharedConfig() says the same
        return () => {}
    }
    const changed = () => {
        bust(entryFor(href))
        if (!callback) {
            return
        }
        if (eager) {
            deliver(sharedConfig({ ...options, fresh: true })) // the event has no value in it: the endpoint is the answer
        } else {
            hand(null) // it changed; sharedConfig() is the value, asked when the app next wants it
        }
    }
    const stopWatching = watchConfig(options.settings ?? null, changed, options)
    if (callback && eager) {
        deliver(sharedConfig(options)) // the snapshot, from the kept answer when there is one
    }
    return () => {
        stopped = true
        stopWatching()
    }
}
