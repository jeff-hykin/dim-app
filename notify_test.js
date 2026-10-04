// deno test notify_test.js
import { assertEquals } from "jsr:@std/assert@1"
import { lowLevelAlert, notify, underDesktop } from "./notify.js"

Deno.test("notify outside Desktop resolves to null without fetching", async () => {
    assertEquals(underDesktop(), false)
    assertEquals(await notify({ title: "x", body: "y" }), null)
})

Deno.test("notify posts the payload to <origin>/api/notifications", async () => {
    const seen = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, init) => {
        seen.push([String(url), JSON.parse(init.body)])
        return Promise.resolve(new Response(JSON.stringify({ id: 7 })))
    }
    try {
        const id = await notify({ title: "Battery low", body: "14%", sound: "battery", kind: "warn", app: "controller" }, { origin: "http://127.0.0.1:7000" })
        assertEquals(id, 7)
        assertEquals(seen[0][0], "http://127.0.0.1:7000/api/notifications")
        assertEquals(seen[0][1].sound, "battery")
        assertEquals(seen[0][1].icon, "/api/apps/controller/icon")
    } finally {
        globalThis.fetch = realFetch
    }
})

Deno.test("lowLevelAlert fires once per dip, re-arms above low + hysteresis", () => {
    const sent = []
    const alert = lowLevelAlert({ low: 20, hysteresis: 5, notification: (v) => ({ title: String(v) }), send: (n) => sent.push(n.title) })
    for (const v of [50, 21, 20, 15, 10, 22, 24, 19, 26, 18, NaN]) {
        alert(v)
    }
    assertEquals(sent, ["20", "18"])
})
