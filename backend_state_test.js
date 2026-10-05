// deno test -A backend_state_test.js
import { assertEquals } from "jsr:@std/assert@1"
import { getZenoh } from "./zenoh.js"
import { resolveSource, watchBackendState } from "./backend_state.js"
import { fakes, INFO, tick } from "./test_fakes.js"

Deno.test("resolveSource: a key or an app-relative URL", () => {
    assertEquals(resolveSource("recordings"), {
        url: "api/state/recordings",
        key: "recordings",
        topic: "state/recordings",
    })
    assertEquals(resolveSource("api/library?sort=name"), {
        url: "api/library?sort=name",
        key: "library",
        topic: "state/library",
    })
    assertEquals(resolveSource("api/state", { key: "app" }), { url: "api/state", key: "app", topic: "state/app" })
    assertEquals(resolveSource("x", { topic: "custom/topic" }).topic, "custom/topic")
})

function setup(handler) {
    let gets = 0
    const fake = fakes({ routes: { "/apps/my-app/api/state/things": () => handler(++gets) } })
    const zenoh = getZenoh({ href: "http://h/apps/my-app/", connect: fake.connect, fetch: fake.fetch })
    return { fake, zenoh, gets: () => gets }
}

Deno.test("watchBackendState: snapshot, newer versions re-GET (debounced, once per burst), older ones don't", async () => {
    const { fake, zenoh, gets } = setup((n) => ({ n }))
    const seen = []
    const watch = watchBackendState("things", (snapshot) => seen.push(snapshot), {
        zenoh,
        fetch: fake.fetch,
        href: "http://h/apps/my-app/",
        debounceMs: 20,
    })
    try {
        await zenoh.ready
        await tick(5)
        assertEquals(seen.at(-1), { data: { n: 1 }, loading: false, error: null, version: null })
        const client = fake.clients[0]
        const key = `${INFO.zenohPrefix}/frontend/state/things`
        client.put(key, { key: "things", version: 10 })
        client.put(key, { key: "things", version: 11 })
        client.put(key, { key: "things", version: 9 })
        await tick(60)
        assertEquals(gets(), 2)
        assertEquals(seen.at(-1).data, { n: 2 })
        assertEquals(seen.at(-1).version, 11)
        client.put(key, { key: "things", version: 11 }) // already have it
        await tick(40)
        assertEquals(gets(), 2)
        client.put(key, { key: "things" }) // no version: always re-GET
        await tick(40)
        assertEquals(gets(), 3)
    } finally {
        watch.stop()
        zenoh.close()
    }
})

Deno.test("watchBackendState: re-GET on reconnect; errors keep the data; refresh(); stop() unsubscribes", async () => {
    let fail = false
    const { fake, zenoh, gets } = setup((n) => {
        if (fail) {
            throw new Error("boom")
        }
        return { n }
    })
    const failingFetch = async (url, init) => fail ? new Response("down", { status: 500 }) : await fake.fetch(url, init)
    const seen = []
    const watch = watchBackendState("things", (snapshot) => seen.push(snapshot), {
        zenoh,
        fetch: failingFetch,
        href: "http://h/apps/my-app/",
        debounceMs: 5,
    })
    await zenoh.ready
    await tick(5)
    const client = fake.clients[0]
    client.setState("lost")
    client.setState("connected")
    await tick(20)
    assertEquals(gets(), 2)
    fail = true
    await watch.refresh()
    assertEquals(seen.at(-1).data, { n: 2 })
    assertEquals(seen.at(-1).error.message, "GET api/state/things: HTTP 500")
    fail = false
    await watch.refresh()
    assertEquals(seen.at(-1), { data: { n: 3 }, loading: false, error: null, version: null })
    watch.stop()
    assertEquals(client.open().length, 0)
    zenoh.close()
})

Deno.test("watchBackendState: an event during a GET re-GETs after it", async () => {
    let release
    const { fake, zenoh, gets } = setup(async (n) => {
        if (n === 1) {
            await new Promise((resolve) => (release = resolve))
        }
        return { n }
    })
    const seen = []
    const watch = watchBackendState("things", (snapshot) => seen.push(snapshot.data), {
        zenoh,
        fetch: fake.fetch,
        href: "http://h/apps/my-app/",
        debounceMs: 5,
    })
    await zenoh.ready
    await tick(5)
    fake.clients[0].put(`${INFO.zenohPrefix}/frontend/state/things`, { key: "things", version: 5 })
    await tick(10)
    release()
    await tick(30)
    assertEquals(gets(), 2)
    assertEquals(seen, [{ n: 1 }, { n: 2 }])
    watch.stop()
    zenoh.close()
})
