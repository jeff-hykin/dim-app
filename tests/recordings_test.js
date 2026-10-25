// deno test -A tests/recordings_test.js
import { assertEquals, assertRejects } from "jsr:@std/assert@1"
import { recordingsDir, watchRecordingsDir } from "../source/recordings.js"

const answer = (body, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

Deno.test("recordingsDir asks <origin>/gateways/dimos/history/recordings once and keeps the answer", async () => {
    const seen = []
    const fetchImpl = (url) => {
        seen.push(String(url))
        return answer({ path: "/home/you/.dimos/recordings" })
    }
    const options = { origin: "http://127.0.0.1:7000", fresh: true, fetch: fetchImpl }
    assertEquals(await recordingsDir(options), "/home/you/.dimos/recordings")
    assertEquals(await recordingsDir({ origin: options.origin, fetch: fetchImpl }), "/home/you/.dimos/recordings")
    assertEquals(seen, ["http://127.0.0.1:7000/gateways/dimos/history/recordings"])
})

Deno.test("recordingsDir { fresh: true } asks again", async () => {
    let n = 0
    const fetchImpl = () => answer({ path: `/dir/${++n}` })
    const options = { origin: "http://127.0.0.1:7001", fetch: fetchImpl }
    assertEquals(await recordingsDir({ ...options, fresh: true }), "/dir/1")
    assertEquals(await recordingsDir(options), "/dir/1")
    assertEquals(await recordingsDir({ ...options, fresh: true }), "/dir/2")
})

Deno.test("a 403 (the call isn't in the app's dimos.yaml) says so, and isn't kept as the answer", async () => {
    let fail = true
    const fetchImpl = () => (fail ? answer({ error: "undeclared" }, 403) : answer({ path: "/dir" }))
    const options = { origin: "http://127.0.0.1:7002", fetch: fetchImpl }
    const error = await assertRejects(() => recordingsDir({ ...options, fresh: true }), Error)
    assertEquals(error.message.includes("403"), true)
    assertEquals(error.message.includes("dimos.yaml"), true)
    fail = false
    assertEquals(await recordingsDir(options), "/dir") // a failure isn't cached
})

Deno.test("an unreachable gateway and an answer without a path both throw", async () => {
    await assertRejects(
        () =>
            recordingsDir({
                origin: "http://127.0.0.1:7003",
                fresh: true,
                fetch: () => Promise.reject(new Error("down")),
            }),
        Error,
        "down",
    )
    await assertRejects(
        () => recordingsDir({ origin: "http://127.0.0.1:7004", fresh: true, fetch: () => answer({}) }),
        Error,
        'no "path"',
    )
})

Deno.test("with no page URL and no origin it says to pass Desktop's URL", async () => {
    await assertRejects(() => recordingsDir({ fresh: true }), Error, "dimContext().desktopUrl")
})

Deno.test("on a page it asks from the app's own base (a path prefix is kept)", async () => {
    const seen = []
    const fetchImpl = (url) => {
        seen.push(String(url))
        return answer({ path: "/dir" })
    }
    const href = "http://127.0.0.1:5555/dimos/apps/dim-recordings/index.html"
    Object.defineProperty(globalThis, "location", { value: new URL(href), configurable: true })
    try {
        await recordingsDir({ fresh: true, fetch: fetchImpl })
        assertEquals(seen, ["http://127.0.0.1:5555/dimos/gateways/dimos/history/recordings"])
    } finally {
        delete globalThis.location
    }
})

/** An AppZenoh stand-in: nothing here loads zenoh.js or its vendored client. */
function fakeZenoh() {
    const subscribed = []
    const reconnects = []
    return {
        subscribeDimos(type, callback) {
            subscribed.push({ type, callback })
            return () => subscribed.splice(subscribed.findIndex((one) => one.callback === callback), 1)
        },
        onReconnect(callback) {
            reconnects.push(callback)
            return () => reconnects.splice(reconnects.indexOf(callback), 1)
        },
        subscribed,
        reconnects,
        sendConfigEvent() {
            for (const one of [...subscribed]) {
                one.callback({ type: "config", setting: "recordingsDir" })
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

Deno.test("watchRecordingsDir subscribes to the one setting's topic and hands over the folder as it moves", async () => {
    let n = 0
    const fetchImpl = () => answer({ path: `/r/${++n}` })
    const zenoh = fakeZenoh()
    const seen = []
    const stop = watchRecordingsDir((dir) => seen.push(dir), {
        origin: "http://127.0.0.1:7200",
        fetch: fetchImpl,
        zenoh,
    })
    await until(() => seen.length === 1)
    assertEquals(seen, ["/r/1"])
    await until(() => zenoh.subscribed.length === 1)
    // the topic of this setting alone: the rest of the file moving doesn't wake the app, or re-ask
    assertEquals(zenoh.subscribed.map((one) => one.type), ["config/recordingsDir"])
    zenoh.sendConfigEvent()
    await until(() => seen.length === 2)
    assertEquals(seen, ["/r/1", "/r/2"])
    stop()
    assertEquals([zenoh.subscribed.length, zenoh.reconnects.length], [0, 0])
    zenoh.sendConfigEvent()
    assertEquals(seen, ["/r/1", "/r/2"]) // stopped: unsubscribed, and nothing is delivered
})

Deno.test("eager: false says it moved and leaves the re-ask to the next recordingsDir()", async () => {
    let n = 0
    const fetchImpl = () => answer({ path: `/r/${++n}` })
    const zenoh = fakeZenoh()
    const seen = []
    const options = { origin: "http://127.0.0.1:7201", fetch: fetchImpl, zenoh, eager: false }
    const stop = watchRecordingsDir((dir) => seen.push(dir), options)
    await until(() => zenoh.subscribed.length === 1)
    assertEquals([seen, n], [[], 0])
    assertEquals(await recordingsDir(options), "/r/1")
    zenoh.sendConfigEvent()
    await until(() => seen.length === 1)
    assertEquals(seen, [null])
    assertEquals(await recordingsDir(options), "/r/2") // the kept answer was dropped by the event
    stop()
})

Deno.test("a watcher that can't subscribe (no zenoh-gateway) reports it instead of throwing", async () => {
    const errors = []
    const stop = watchRecordingsDir(null, {
        origin: "http://127.0.0.1:7202",
        zenoh: {
            subscribeDimos() {
                throw new Error("no zenoh-gateway here")
            },
            onReconnect: () => () => {},
        },
        onError: (error) => errors.push(String(error)),
    })
    await until(() => errors.length === 1)
    assertEquals(errors[0].includes("no zenoh-gateway here"), true)
    stop()
})

Deno.test("with no page URL and no origin, watching says to pass Desktop's URL and never throws", async () => {
    const errors = []
    const stop = watchRecordingsDir(() => {}, { onError: (error) => errors.push(String(error)) })
    await until(() => errors.length === 1)
    assertEquals(errors[0].includes("dimContext().desktopUrl"), true)
    stop()
})
