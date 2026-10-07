// deno test -A dim_app_test.js
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1"
import { DimApp, dimosKey } from "./dim_app.js"
import { fakes, tick } from "./test_fakes.js"

const HREF = "http://h:7341/apps/my-app/"
const MSGS_TS = new URL(`file://${Deno.env.get("HOME")}/repos/dimos_server_live/dimos/gateway/msgs/msgs.ts`)
const hasRealMsgs = (() => {
    try {
        return Deno.statSync(MSGS_TS).isFile
    } catch {
        return false
    }
})()

/** A codec module with one type, "test_msgs.Num": one byte → { n }. */
function fakeMsgs() {
    const Num = {
        name: "test_msgs.Num",
        decode: (bytes) => ({ n: bytes[0] }),
        encode: (value) => new Uint8Array([value.n ?? 0]),
        zenohKey: (topic) => `${topic}/test_msgs.Num`,
    }
    const typeOfChannel = (key) => {
        const name = key.slice(key.lastIndexOf("/") + 1)
        return /^\w+\.\w+$/.test(name) ? name : undefined
    }
    return {
        test_msgs: { Num },
        typeOfChannel,
        lookup: (name) => {
            if (name !== Num.name) {
                throw new Error(`unknown message type ${name}`)
            }
            return Num
        },
        decodeChannel: (key, bytes) => {
            if (typeOfChannel(key) !== Num.name) {
                throw new Error(`no message type for ${key}`)
            }
            return Num.decode(bytes)
        },
    }
}

/** Runs `body(app, client)` with a DimApp on a fake gateway, closing the shared connection after. */
async function withApp(options, body) {
    const fake = fakes()
    const app = new DimApp({ href: HREF, connect: fake.connect, fetch: fake.fetch, ...options })
    try {
        await app.zenoh.ready
        await app.msgsReady
        await body(app, fake.clients[0])
    } finally {
        app.zenoh.close()
    }
}

Deno.test("dimosKey: a topic name, with or without its slashes or dimos/", () => {
    assertEquals(dimosKey("odom"), "dimos/odom")
    assertEquals(dimosKey("/odom/"), "dimos/odom")
    assertEquals(dimosKey("dimos/map/cloud"), "dimos/map/cloud")
    assertThrows(() => dimosKey("/"))
})

Deno.test("DimApp: msgDecodeEndpoint is required", () => {
    assertThrows(() => new DimApp({ href: HREF }), Error, "DimApp needs msgDecodeEndpoint")
})

Deno.test("DimApp: subscribe decodes by the key's type; unknown types come raw with one warning", async () => {
    await withApp({ msgs: fakeMsgs() }, async (app, client) => {
        const seen = []
        const off = app.subscribe("odom", (message, info) => seen.push([message, info.key, info.type]))
        await tick()
        assertEquals(client.open().map((s) => [s.key, s.options.delivery]), [["dimos/odom/*", "latest"]])
        const warnings = []
        const warn = console.warn
        console.warn = (...args) => warnings.push(args[0])
        try {
            client.put("dimos/odom/test_msgs.Num", new Uint8Array([7]))
            client.put("dimos/odom/other_msgs.Thing", new Uint8Array([1, 2]))
            client.put("dimos/odom/other_msgs.Thing", new Uint8Array([3]))
        } finally {
            console.warn = warn
        }
        assertEquals(seen[0], [{ n: 7 }, "dimos/odom/test_msgs.Num", "test_msgs.Num"])
        assertEquals([...seen[1][0]], [1, 2])
        assertEquals(seen[1][2], "other_msgs.Thing")
        assertEquals([...seen[2][0]], [3])
        assertEquals(warnings.length, 1)
        off()
        assertEquals(client.open().length, 0)
    })
})

Deno.test("DimApp: subscribe with a type and reliable delivery; info.receivedAt; unsubscribe before the codec loads", async () => {
    await withApp({ msgs: fakeMsgs() }, async (app, client) => {
        let info = null
        app.subscribe("/battery", (_, i) => (info = i), { type: "test_msgs.Num", delivery: "reliable" })
        const off = app.subscribe("never", () => {})
        off() // before the codec promise settles: never opens
        await tick()
        assertEquals(client.open().map((s) => [s.key, s.options.delivery]), [[
            "dimos/battery/test_msgs.Num",
            "reliable",
        ]])
        const before = Date.now()
        client.put("dimos/battery/test_msgs.Num", new Uint8Array([1]))
        assert(info.receivedAt >= before)
    })
})

Deno.test("DimApp: publish encodes by type name or type object; publisher puts and arms a deadman", async () => {
    await withApp({ msgs: fakeMsgs() }, async (app, client) => {
        await app.publish("cmd", "test_msgs.Num", { n: 5 })
        await app.publish("cmd", app.msgs.test_msgs.Num, { n: 6 })
        assertEquals(client.puts.map(([key, bytes]) => [key, [...bytes]]), [
            ["dimos/cmd/test_msgs.Num", [5]],
            ["dimos/cmd/test_msgs.Num", [6]],
        ])
        await assertRejects(() => app.publish("cmd", "nope.Nope", {}), Error, "unknown message type")
        const publisher = await app.publisher("cmd", "test_msgs.Num", { delivery: "latest" })
        publisher.put({ n: 9 })
        await publisher.setDeadman({})
        const raw = client.publishers[0]
        assertEquals([raw.key, raw.options, [...raw.sent[0]], [...raw.deadman]], [
            "dimos/cmd/test_msgs.Num",
            { delivery: "latest" },
            [9],
            [0],
        ])
        publisher.close()
        assert(raw.closed)
    })
})

Deno.test("DimApp: an endpoint that doesn't load leaves messages raw", async () => {
    const warn = console.warn
    console.warn = () => {}
    try {
        await withApp({ msgDecodeEndpoint: "data:text/javascript,throw new Error('boom')" }, async (app, client) => {
            assertEquals(app.msgs, null)
            let got = null
            app.subscribe("odom", (message) => (got = message))
            await tick()
            client.put("dimos/odom/nav_msgs.Odometry", new Uint8Array([4]))
            assertEquals([...got], [4])
            await assertRejects(() => app.publish("cmd_vel", "geometry_msgs.Twist", {}), Error, "didn't load")
        })
    } finally {
        console.warn = warn
    }
})

Deno.test({
    name: "DimApp: round trip through the real generated msgs.ts (imported by msgDecodeEndpoint)",
    ignore: !hasRealMsgs,
    fn: async () => {
        await withApp({ msgDecodeEndpoint: MSGS_TS.href }, async (app, client) => {
            assertEquals(app.msgDecodeEndpoint, MSGS_TS.href)
            const seen = []
            app.subscribe("cmd_vel", (message, info) => seen.push([message, info.type]))
            await tick()
            await app.publish("cmd_vel", "geometry_msgs.Twist", { linear: { x: 0.3 }, angular: { z: -1 } })
            assertEquals(client.puts[0][0], "dimos/cmd_vel/geometry_msgs.Twist")
            assertEquals(seen, [[
                { linear: { x: 0.3, y: 0, z: 0 }, angular: { x: 0, y: 0, z: -1 } },
                "geometry_msgs.Twist",
            ]])
        })
    },
})
