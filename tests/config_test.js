// deno test -A tests/config_test.js
import { assertEquals, assertRejects } from "jsr:@std/assert@1"
import { CONFIG_EVENT, sharedConfig, watchSharedConfig } from "../source/config.js"

const answer = (body, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

/** An AppZenoh stand-in: nothing here loads zenoh.js or its vendored client. */
function fakeZenoh() {
    const subscribed = []
    const reconnects = []
    return {
        subscribeDimos(type, callback) {
            subscribed.push({ type, callback })
            return () => subscribed.splice(subscribed.indexOf(subscribed.find((one) => one.callback === callback)), 1)
        },
        onReconnect(callback) {
            reconnects.push(callback)
            return () => reconnects.splice(reconnects.indexOf(callback), 1)
        },
        subscribed,
        reconnects,
        sendConfigEvent(setting = "recordingsDir") {
            for (const one of [...subscribed]) {
                one.callback({ type: "config", setting })
            }
        },
        reconnect() {
            for (const callback of [...reconnects]) {
                callback()
            }
        },
    }
}

/** Resolves once `check()` is true (the watcher's own fetches are promise-chained, not timed). */
async function until(check) {
    for (let tries = 0; tries < 200; tries++) {
        if (check()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw new Error("gave up waiting")
}

const CONFIG = { path: "/home/you/.dimos/config.yaml", recordingsDir: "/home/you/.dimos/recordings" }

Deno.test("sharedConfig asks <origin>/gateways/dimos/config once and keeps the answer", async () => {
    const seen = []
    const fetchImpl = (url) => {
        seen.push(String(url))
        return answer(CONFIG)
    }
    const options = { origin: "http://127.0.0.1:7100", fetch: fetchImpl }
    assertEquals(await sharedConfig({ ...options, fresh: true }), CONFIG)
    assertEquals(await sharedConfig(options), CONFIG)
    assertEquals(await sharedConfig(options), CONFIG)
    assertEquals(seen, ["http://127.0.0.1:7100/gateways/dimos/config"])
})

Deno.test("sharedConfig { fresh: true } asks again", async () => {
    let n = 0
    const fetchImpl = () => answer({ path: `/c/${++n}`, recordingsDir: `/r/${n}` })
    const options = { origin: "http://127.0.0.1:7101", fetch: fetchImpl }
    assertEquals((await sharedConfig({ ...options, fresh: true })).path, "/c/1")
    assertEquals((await sharedConfig(options)).path, "/c/1")
    assertEquals((await sharedConfig({ ...options, fresh: true })).path, "/c/2")
})

Deno.test("a 403 (the call isn't in the app's dimos.yaml) says so, and isn't kept as the answer", async () => {
    let fail = true
    const fetchImpl = () => (fail ? answer({ error: "undeclared" }, 403) : answer(CONFIG))
    const options = { origin: "http://127.0.0.1:7102", fetch: fetchImpl }
    const error = await assertRejects(() => sharedConfig({ ...options, fresh: true }), Error)
    assertEquals(error.message.includes("403"), true)
    assertEquals(error.message.includes("dimos.yaml"), true)
    fail = false
    assertEquals(await sharedConfig(options), CONFIG) // a failure isn't cached
})

Deno.test("with no answer yet, an unreachable gateway and an answer without a path both throw", async () => {
    await assertRejects(
        () =>
            sharedConfig({
                origin: "http://127.0.0.1:7103",
                fresh: true,
                fetch: () => Promise.reject(new Error("down")),
            }),
        Error,
        "down",
    )
    await assertRejects(
        () => sharedConfig({ origin: "http://127.0.0.1:7104", fresh: true, fetch: () => answer({}) }),
        Error,
        'no "path"',
    )
})

Deno.test("with no page URL and no origin it says to pass Desktop's URL", async () => {
    await assertRejects(() => sharedConfig({ fresh: true }), Error, "dimContext().desktopUrl")
})

Deno.test("on a page it asks from the app's own base (a path prefix is kept)", async () => {
    const seen = []
    const fetchImpl = (url) => {
        seen.push(String(url))
        return answer(CONFIG)
    }
    const href = "http://127.0.0.1:5555/dimos/apps/dim-settings/index.html"
    Object.defineProperty(globalThis, "location", { value: new URL(href), configurable: true })
    try {
        await sharedConfig({ fresh: true, fetch: fetchImpl })
        assertEquals(seen, ["http://127.0.0.1:5555/dimos/gateways/dimos/config"])
    } finally {
        delete globalThis.location
    }
})

Deno.test("a watcher with no callback subscribes to the config event and only busts the cache", async () => {
    let n = 0
    const fetchImpl = () => answer({ path: `/c/${++n}`, recordingsDir: "/r" })
    const zenoh = fakeZenoh()
    const options = { origin: "http://127.0.0.1:7105", fetch: fetchImpl, zenoh }
    assertEquals((await sharedConfig({ ...options, fresh: true })).path, "/c/1")
    const stop = watchSharedConfig(null, options)
    await until(() => zenoh.subscribed.length === 1)
    assertEquals(zenoh.subscribed[0].type, `${CONFIG_EVENT}/**`) // every setting, each on its own topic
    assertEquals(n, 1) // no callback: nothing was re-asked for
    zenoh.sendConfigEvent()
    assertEquals(n, 1) // and nothing is asked until someone reads
    assertEquals((await sharedConfig(options)).path, "/c/2")
    assertEquals((await sharedConfig(options)).path, "/c/2") // fresh again: kept
    stop()
    assertEquals(zenoh.subscribed.length, 0)
    assertEquals(zenoh.reconnects.length, 0)
})

Deno.test("a watcher with a callback gets the config now and again on every config event", async () => {
    let n = 0
    const fetchImpl = () => answer({ path: `/c/${++n}`, recordingsDir: "/r" })
    const zenoh = fakeZenoh()
    const seen = []
    const stop = watchSharedConfig((config) => seen.push(config.path), {
        origin: "http://127.0.0.1:7106",
        fetch: fetchImpl,
        zenoh,
    })
    await until(() => seen.length === 1)
    assertEquals(seen, ["/c/1"])
    zenoh.sendConfigEvent()
    await until(() => seen.length === 2)
    assertEquals(seen, ["/c/1", "/c/2"])
    stop()
    zenoh.sendConfigEvent()
    assertEquals(seen, ["/c/1", "/c/2"]) // stopped: unsubscribed, and nothing is delivered
})

Deno.test("a reconnect re-asks too (events published while the link was down are gone)", async () => {
    let n = 0
    const fetchImpl = () => answer({ path: `/c/${++n}`, recordingsDir: "/r" })
    const zenoh = fakeZenoh()
    const seen = []
    const stop = watchSharedConfig((config) => seen.push(config.path), {
        origin: "http://127.0.0.1:7107",
        fetch: fetchImpl,
        zenoh,
    })
    await until(() => seen.length === 1)
    zenoh.reconnect()
    await until(() => seen.length === 2)
    assertEquals(seen, ["/c/1", "/c/2"])
    stop()
})

Deno.test("a failed re-ask leaves the last answer standing (stale), and the call after it asks again", async () => {
    let fail = false
    let n = 0
    const fetchImpl =
        () => (fail ? Promise.reject(new Error("gateway blip")) : answer({ path: `/c/${++n}`, recordingsDir: "/r" }))
    const zenoh = fakeZenoh()
    const options = { origin: "http://127.0.0.1:7108", fetch: fetchImpl, zenoh }
    assertEquals((await sharedConfig({ ...options, fresh: true })).path, "/c/1")
    const stop = watchSharedConfig(null, options)
    await until(() => zenoh.subscribed.length === 1)
    zenoh.sendConfigEvent()
    fail = true
    assertEquals((await sharedConfig(options)).path, "/c/1") // the blip doesn't break a working app
    await assertRejects(() => sharedConfig({ ...options, fresh: true }), Error, "gateway blip") // but a strict read does fail
    fail = false
    assertEquals((await sharedConfig(options)).path, "/c/2") // still busted: it asks again
    stop()
})

Deno.test("a watcher's failures go to onError, and it never throws", async () => {
    const errors = []
    const zenoh = fakeZenoh()
    const stop = watchSharedConfig(() => {}, {
        origin: "http://127.0.0.1:7109",
        fetch: () => Promise.reject(new Error("down")),
        zenoh,
        onError: (error) => errors.push(String(error)),
    })
    await until(() => errors.length === 1)
    assertEquals(errors[0].includes("down"), true)
    stop()
})

Deno.test("a watcher that can't subscribe (no zenoh-gateway) reports it instead of throwing", async () => {
    const errors = []
    const stop = watchSharedConfig(null, {
        origin: "http://127.0.0.1:7110",
        zenoh: {
            subscribeDimos() {
                throw new Error("no zenoh-gateway here")
            },
            onReconnect: () => () => {},
        },
        onError: (error) => errors.push(String(error)),
    })
    await until(() => errors.length === 1)
    assertEquals(errors[0].includes("no zenoh-gateway"), true)
    stop()
})

Deno.test("with no page URL and no origin, a watcher reports and watches nothing", () => {
    const errors = []
    const stop = watchSharedConfig(null, { onError: (error) => errors.push(String(error)) })
    assertEquals(errors.length, 1)
    assertEquals(errors[0].includes("dimContext().desktopUrl"), true)
    stop()
})

Deno.test("a callback that throws doesn't take the watcher down", async () => {
    const zenoh = fakeZenoh()
    let calls = 0
    const stop = watchSharedConfig(() => {
        calls++
        throw new Error("render blew up")
    }, { origin: "http://127.0.0.1:7111", fetch: () => answer(CONFIG), zenoh })
    await until(() => calls === 1)
    zenoh.sendConfigEvent()
    await until(() => calls === 2)
    assertEquals(zenoh.subscribed.length, 1) // still subscribed
    stop()
})

Deno.test("settings: narrows the subscription to the topics of the settings the app reads", async () => {
    const zenoh = fakeZenoh()
    const stop = watchSharedConfig(null, {
        origin: "http://127.0.0.1:7111",
        fetch: () => answer(CONFIG),
        zenoh,
        settings: ["recordingsDir"],
    })
    await until(() => zenoh.subscribed.length === 1)
    assertEquals(zenoh.subscribed.map((one) => one.type), ["config/recordingsDir"])
    stop()
    assertEquals(zenoh.subscribed.length, 0)
})

Deno.test("eager: false calls back with null and leaves the re-ask to the next sharedConfig()", async () => {
    let n = 0
    const fetchImpl = () => answer({ path: `/c/${++n}`, recordingsDir: "/r" })
    const zenoh = fakeZenoh()
    const seen = []
    const options = { origin: "http://127.0.0.1:7112", fetch: fetchImpl, zenoh, eager: false }
    const stop = watchSharedConfig((config) => seen.push(config), options)
    await until(() => zenoh.subscribed.length === 1)
    assertEquals([seen, n], [[], 0]) // lazy: no snapshot ask either
    zenoh.sendConfigEvent()
    await until(() => seen.length === 1)
    assertEquals([seen, n], [[null], 0]) // "it changed"; the value is the next read's
    assertEquals((await sharedConfig(options)).path, "/c/1")
    assertEquals(n, 1)
    stop()
})
