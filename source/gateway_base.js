// The two things every "ask the gateway, stay current" helper needs: where Desktop is, and the gateway's config bust
// signal. Shared by recordings.js and config.js rather than copied into each — a third use is what it was waiting for.
//
//     import { desktopBase, watchConfig } from "./dim-app/source/gateway_base.js"
//     const url = new URL("gateways/dimos/config", desktopBase(options.origin, "sharedConfig"))
//     const stop = watchConfig(["recordingsDir"], () => reask(), { onError: report })
//
// `watchConfig` is the listening half of every config-backed answer, in one place: the dimos gateway watches
// `$DIMOS_HOME/config.yaml` and publishes `{"type": "config", "setting": "<setting>"}` on
// `<ns>/dimos/events/config/<setting>` when the answer it would give for that setting moves. The event carries **no
// value** — `GET /gateways/dimos/config` stays the one answer, so a listener's cache and the event can never say
// different things. Subscribing per setting is the point: an app that only cares where recordings go doesn't wake, or
// re-ask, when something else in the file changes.
//
// zenoh is loaded lazily (`import("./zenoh.js")`), so a file that only *asks* never pulls in the browser's
// zenoh-gateway client, and a Deno backend that has no zenoh-gateway at all gets `onError` and a plain cache.

/** The gateway's event type for a shared-config change; the setting that moved is the next chunk, and the payload. */
export const CONFIG_EVENT = "config"

/**
 * Desktop's base URL, ending in `/`: `origin`, or this page's own (`<origin><prefix>/apps/<name>/` → `<origin><prefix>/`,
 * so an app under a path prefix asks the right place).
 * @param {string | undefined} origin
 * @param {string} who the caller's name, for the error a page-less process gets
 * @returns {string}
 */
export function desktopBase(origin, who) {
    if (origin) {
        return origin.endsWith("/") ? origin : `${origin}/`
    }
    const href = globalThis.location?.href
    if (!href) {
        throw new Error(
            `${who}: no page URL to ask from; pass { origin: dimContext().desktopUrl } (a backend's DIMOS_APP has it)`,
        )
    }
    const url = new URL(href)
    const match = url.pathname.match(/^(.*?)\/apps\/[^/]+\//)
    return `${url.origin}${match ? match[1] : ""}/`
}

/**
 * Subscribes to the gateway's config bust signal for `settings` (`[]` or `null`: every setting) and calls
 * `changed(setting)` for each one — and on a reconnect, with `null`, because events published while the link was down
 * are gone. Never throws: a failed subscribe goes to `onError` (default: console.debug).
 * @param {string[] | null} settings keys of `GET /gateways/dimos/config` (`"recordingsDir"`, `"path"`)
 * @param {(setting: string | null) => void} changed
 * @param {{ zenoh?: any, onError?: (error: unknown) => void }} [options] `zenoh`: an AppZenoh to subscribe on
 *   (default: the page's one connection, loaded lazily from zenoh.js)
 * @returns {() => void} stop watching
 */
export function watchConfig(settings, changed, options = {}) {
    let stopped = false
    let off = null
    const report = (error) => {
        if (stopped) {
            return
        }
        if (!options.onError) {
            console.debug("[dim-app] watchConfig:", error)
            return
        }
        try {
            options.onError(error)
        } catch (thrown) {
            console.error("[dim-app] watchConfig onError threw:", thrown)
        }
    }
    const topics = settings?.length ? settings.map((setting) => `${CONFIG_EVENT}/${setting}`) : [`${CONFIG_EVENT}/**`]
    ;(async () => {
        const zenoh = options.zenoh ?? (await import("./zenoh.js")).getZenoh()
        if (stopped) {
            return
        }
        const offs = topics.map((topic) => zenoh.subscribeDimos(topic, (payload) => changed(payload?.setting ?? null)))
        offs.push(zenoh.onReconnect(() => changed(null)))
        off = () => offs.forEach((stop) => stop())
        if (stopped) {
            off()
            off = null
        }
    })().catch(report)
    return () => {
        stopped = true
        off?.()
        off = null
    }
}
