// deno test -A tests/recordings_test.js
import { assertEquals, assertRejects } from "jsr:@std/assert@1"
import { recordingsDir } from "../source/recordings.js"

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
