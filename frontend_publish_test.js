// deno test -A frontend_publish_test.js
import { assertEquals, assertThrows } from "jsr:@std/assert@1"
import { publishFrontend, stateChanged } from "./frontend_publish.js"

function relay({ delay = () => 0, status = 200 } = {}) {
    const got = []
    const server = Deno.serve({ port: 0, onListen() {} }, async (request) => {
        const body = new Uint8Array(await request.arrayBuffer())
        const index = got.length
        got.push({ path: new URL(request.url).pathname, type: request.headers.get("content-type"), body })
        await new Promise((resolve) => setTimeout(resolve, delay(index)))
        if (status !== 200) {
            return new Response("nope", { status })
        }
        return Response.json({ ok: true, key: `ns/apps/x${new URL(request.url).pathname}`, bytes: body.length })
    })
    return { got, server, app: { name: "my-app", desktopUrl: `http://127.0.0.1:${server.addr.port}/` } }
}

Deno.test("publishFrontend: POSTs to the relay as JSON, bytes or text, in order", async () => {
    const { got, server, app } = relay({ delay: (index) => (index === 0 ? 50 : 0) })
    try {
        const answers = await Promise.all([
            publishFrontend("status", { battery: 0.8 }, { app }),
            publishFrontend("map/cloud", new Uint8Array([1, 2]), { app }),
            publishFrontend("log", "hi", { app, contentType: "text/plain" }),
        ])
        assertEquals(got.map((g) => g.path), [
            "/desktop/frontend/my-app/status",
            "/desktop/frontend/my-app/map/cloud",
            "/desktop/frontend/my-app/log",
        ])
        assertEquals(got.map((g) => g.type), ["application/json", "application/octet-stream", "text/plain"])
        assertEquals(new TextDecoder().decode(got[0].body), '{"battery":0.8}')
        assertEquals(answers[0].ok, true)
        assertEquals(answers[1].bytes, 2)
    } finally {
        await server.shutdown()
    }
})

Deno.test("publishFrontend: never throws for a failed publish; a bad topic is a TypeError", async () => {
    const { server, app } = relay({ status: 503 })
    try {
        assertEquals(await publishFrontend("status", {}, { app }), null)
        assertEquals(
            await publishFrontend("status", {}, { app: { name: "x", desktopUrl: "http://127.0.0.1:9/" } }),
            null,
        )
        assertEquals(await publishFrontend("status", {}, { app: { name: null, desktopUrl: null } }), null)
        assertThrows(() => publishFrontend("a/*", {}, { app }), TypeError)
    } finally {
        await server.shutdown()
    }
})

Deno.test("stateChanged: {key, version} on state/<key>, versions only grow", async () => {
    const { got, server, app } = relay()
    try {
        await stateChanged("things", undefined, { app })
        await stateChanged("things", undefined, { app })
        await stateChanged("other", 3, { app })
        const bodies = got.map((g) => JSON.parse(new TextDecoder().decode(g.body)))
        assertEquals(got.map((g) => g.path), [
            "/desktop/frontend/my-app/state/things",
            "/desktop/frontend/my-app/state/things",
            "/desktop/frontend/my-app/state/other",
        ])
        assertEquals(bodies[1].version > bodies[0].version, true)
        assertEquals(bodies[0].version >= Date.now() - 10_000, true)
        assertEquals(bodies[2], { key: "other", version: 3 })
    } finally {
        await server.shutdown()
    }
})
