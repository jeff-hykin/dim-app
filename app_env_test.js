import { assertEquals } from "jsr:@std/assert@1"
import { readDimosApp } from "./app_env.js"

function withDimosApp(value, fn) {
    if (value === undefined) {
        Deno.env.delete("DIMOS_APP")
    } else {
        Deno.env.set("DIMOS_APP", value)
    }
    try {
        return fn()
    } finally {
        Deno.env.delete("DIMOS_APP")
    }
}

Deno.test("DIMOS_APP is read as is; a field it lacks is null", () => {
    const app = {
        version: 2,
        name: "b",
        socket: "/s/b.sock",
        url: "http://127.0.0.1:7341/apps/b/",
        path: "/apps/b/",
        dataDir: "/d/b",
        desktopUrl: "http://127.0.0.1:7341",
        zenohGatewayUrl: "http://127.0.0.1:7341/zenoh-gateway",
        later: "kept",
    }
    const read = withDimosApp(JSON.stringify(app), () => readDimosApp())
    assertEquals(read.socket, "/s/b.sock")
    assertEquals(read.url, "http://127.0.0.1:7341/apps/b/")
    assertEquals(read.zenohGatewayUrl, "http://127.0.0.1:7341/zenoh-gateway")
    assertEquals(read.later, "kept")
    assertEquals(read.zenohConnect, null)
})

Deno.test("outside Desktop: every field null", () => {
    const read = withDimosApp(undefined, () => readDimosApp())
    assertEquals(read.socket, null)
    assertEquals(read.desktopUrl, null)
})
