// Test doubles for zenoh.js: a fake zenoh-web client and Desktop's discovery answer.
export const INFO = {
    namespace: "dimos-desktop/test-7341",
    desktop: "dimos-desktop/test-7341/desktop",
    dimos: "dimos-desktop/test-7341/dimos",
    apps: "dimos-desktop/test-7341/apps",
    zenohPrefix: "dimos-desktop/test-7341/apps/my-app",
    zenohWebUrl: "/zenoh-web",
    client: "https://example.invalid/zenoh_web.ts",
    up: true,
}

/** zenoh key expression match for `*` (one chunk) and `**` (any number of chunks). */
export function keyMatches(expression, key) {
    const match = (e, k) => {
        if (!e.length) {
            return !k.length
        }
        if (e[0] === "**") {
            return match(e.slice(1), k) || (k.length > 0 && match(e, k.slice(1)))
        }
        return k.length > 0 && (e[0] === "*" || e[0] === k[0]) && match(e.slice(1), k.slice(1))
    }
    return match(expression.split("/"), key.split("/"))
}

export class FakeClient {
    state = "connected"
    subscriptions = []
    #listeners = new Set()
    constructor(url, options) {
        this.url = url
        this.options = options
    }
    subscribe(key, options, callback) {
        const subscription = {
            key,
            options,
            callback,
            closed: false,
            close() {
                this.closed = true
            },
        }
        this.subscriptions.push(subscription)
        return subscription
    }
    open() {
        return this.subscriptions.filter((subscription) => !subscription.closed)
    }
    onState(listener) {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }
    setState(state) {
        this.state = state
        this.#listeners.forEach((listener) => listener(state))
    }
    put(key, payload) {
        const bytes = payload instanceof Uint8Array
            ? payload
            : new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload))
        for (const subscription of this.open()) {
            if (keyMatches(subscription.key, key)) {
                subscription.callback({ key, bytes, timestamp: 0, seq: 0 })
            }
        }
    }
    close() {}
}

/** `{ connect, clients, fetch, fetched }`: connect fails `failConnects` times first; discovery answers INFO. */
export function fakes({ failConnects = 0, failDiscovery = 0, routes = {} } = {}) {
    const clients = []
    const fetched = []
    return {
        clients,
        fetched,
        connect: (url, options) => {
            if (failConnects-- > 0) {
                return Promise.reject(new Error("bridge down"))
            }
            const client = new FakeClient(url, options)
            clients.push(client)
            return Promise.resolve(client)
        },
        fetch: async (url) => {
            fetched.push(String(url))
            const path = new URL(url).pathname
            if (path.endsWith("/api/desktop/zenoh")) {
                if (failDiscovery-- > 0) {
                    return new Response("starting", { status: 503 })
                }
                return Response.json(INFO)
            }
            const route = routes[path]
            if (!route) {
                return new Response("no", { status: 404 })
            }
            return Response.json(typeof route === "function" ? await route() : route)
        },
    }
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
