// deno test -A zenoh_test.js
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1"
import { appBase, checkTopic, getZenoh } from "./zenoh.js"
import { fakes, INFO, tick } from "./test_fakes.js"

Deno.test("appBase: Desktop's base and the app's name from a page URL", () => {
    assertEquals(appBase("http://h:7341/apps/my-app/"), { base: "http://h:7341/", app: "my-app" })
    assertEquals(appBase("http://h:7341/apps/my-app/view/x?y=1"), { base: "http://h:7341/", app: "my-app" })
    assertEquals(appBase("https://h/desk/apps/a%20b/"), { base: "https://h/desk/", app: "a b" })
    assertEquals(appBase("http://h:7341/"), { base: "http://h:7341/", app: null })
})

Deno.test("checkTopic: relay chunks, wildcards only when subscribing", () => {
    assertEquals(checkTopic("map/cloud.v2"), "map/cloud.v2")
    assertThrows(() => checkTopic("a//b"))
    assertThrows(() => checkTopic("a/*"))
    assertThrows(() => checkTopic("a b"))
    assertEquals(checkTopic("state/**", { wildcards: true }), "state/**")
})

Deno.test("getZenoh: one shared connection, discovery with ?app, keys under the namespace, JSON payloads", async () => {
    const fake = fakes({ failDiscovery: 1 })
    const zenoh = getZenoh({ href: "http://h:7341/apps/my-app/", connect: fake.connect, fetch: fake.fetch })
    try {
        assert(getZenoh() === zenoh, "a second getZenoh() is the same connection")
        const seen = []
        zenoh.subscribeFrontend("status", (payload) => seen.push(["status", payload])) // before connecting
        zenoh.subscribeDesktop("apps", (event) => seen.push(["apps", event]))
        zenoh.subscribeDimos("*", (event) => seen.push(["dimos", event]))
        await zenoh.ready
        assertEquals(fake.fetched[0], "http://h:7341/api/desktop/zenoh?app=my-app")
        assertEquals(fake.clients.length, 1)
        assertEquals(fake.clients[0].url, "http://h:7341/zenoh-web")
        assertEquals(zenoh.namespace, INFO.namespace)
        assertEquals(zenoh.prefix, INFO.zenohPrefix)
        assertEquals(fake.clients[0].open().map((s) => [s.key, s.options.delivery]), [
            [`${INFO.zenohPrefix}/frontend/status`, "reliable"],
            [`${INFO.desktop}/events/apps`, "reliable"],
            [`${INFO.dimos}/events/**`, "reliable"],
        ])
        const client = fake.clients[0]
        client.put(`${INFO.zenohPrefix}/frontend/status`, { battery: 0.8 })
        client.put(`${INFO.zenohPrefix}/frontend/status`, "not json{")
        client.put(`${INFO.desktop}/events/apps`, { type: "apps" })
        client.put(`${INFO.dimos}/events/launch`, { type: "launch" })
        assertEquals(seen, [["status", { battery: 0.8 }], ["apps", { type: "apps" }], ["dimos", { type: "launch" }]])
    } finally {
        zenoh.close()
    }
})

Deno.test("getZenoh: same key shares one channel; the last unsubscribe closes it; text and bytes parsing", async () => {
    const fake = fakes()
    const zenoh = getZenoh({ href: "http://h/apps/my-app/", connect: fake.connect, fetch: fake.fetch })
    try {
        await zenoh.ready
        const a = []
        const b = []
        const offA = zenoh.subscribeFrontend("log", (text) => a.push(text), { parse: "text" })
        const offB = zenoh.subscribeFrontend("log", (text) => b.push(text), { parse: "text" })
        const client = fake.clients[0]
        assertEquals(client.open().length, 1)
        client.put(`${INFO.zenohPrefix}/frontend/log`, "hello")
        assertEquals([a, b], [["hello"], ["hello"]])
        offA()
        assertEquals(client.open().length, 1)
        offB()
        assertEquals(client.open().length, 0)
        let bytes = null
        zenoh.subscribeFrontend("raw", (payload) => (bytes = payload), { parse: "bytes", delivery: "latest" })
        client.put(`${INFO.zenohPrefix}/frontend/raw`, new Uint8Array([1, 2, 3]))
        assertEquals([...bytes], [1, 2, 3])
        assertEquals(client.open()[0].options.delivery, "latest")
    } finally {
        zenoh.close()
    }
})

Deno.test("getZenoh: retries connecting, reports states, onReconnect only after lost", async () => {
    const fake = fakes({ failConnects: 1 })
    const zenoh = getZenoh({
        href: "http://h/apps/my-app/",
        connect: fake.connect,
        fetch: fake.fetch,
        connectOptions: { heartbeatHz: 10 },
    })
    try {
        const states = []
        let reconnects = 0
        zenoh.onState((state) => states.push(state))
        zenoh.onReconnect(() => reconnects++)
        await zenoh.ready
        assertEquals(fake.clients[0].options, { heartbeatHz: 10 })
        const client = fake.clients[0]
        client.setState("degraded")
        client.setState("connected")
        assertEquals(reconnects, 0)
        client.setState("lost")
        client.setState("connecting")
        client.setState("connected")
        assertEquals(reconnects, 1)
        assertEquals(states, ["connected", "degraded", "connected", "lost", "connecting", "connected"])
    } finally {
        zenoh.close()
    }
})

Deno.test("getZenoh: subscriptions made before connecting open once connected; jobs key", async () => {
    const fake = fakes()
    const zenoh = getZenoh({ href: "http://h/apps/my-app/", connect: fake.connect, fetch: fake.fetch })
    try {
        const lines = []
        zenoh.subscribeJob("j42", (event) => lines.push(event))
        await tick()
        await zenoh.ready
        fake.clients[0].put(`${INFO.desktop}/jobs/j42`, { type: "line", n: 0, line: "hi" })
        assertEquals(lines, [{ type: "line", n: 0, line: "hi" }])
    } finally {
        zenoh.close()
    }
})
