import { assertEquals } from "jsr:@std/assert@1"
import { readDimosApp } from "./app_env.js"

const old = [
    "DIMOS_APP",
    "DIMOS_APP_NAME",
    "DIMOS_APP_SOCKET",
    "DIMOS_APP_DATA",
    "DIMOS_DESKTOP_URL",
    "ZENOH_WEB_URL",
]

function withEnv(env, fn) {
    for (const key of old) {
        Deno.env.delete(key)
    }
    for (const [key, value] of Object.entries(env)) {
        Deno.env.set(key, value)
    }
    try {
        return fn()
    } finally {
        for (const key of old) {
            Deno.env.delete(key)
        }
    }
}

Deno.test("DIMOS_APP wins over the old flags", () => {
    const app = {
        version: 1,
        name: "b",
        socket: "/s/b.sock",
        url: "http://127.0.0.1:7341/apps/b/",
        path: "/apps/b/",
        dataDir: "/d/b",
        desktopUrl: "http://127.0.0.1:7341",
    }
    const read = withEnv(
        { DIMOS_APP: JSON.stringify(app) },
        () => readDimosApp(["--socket", "/old.sock"]),
    )
    assertEquals(read.socket, "/s/b.sock")
    assertEquals(read.url, "http://127.0.0.1:7341/apps/b/")
    assertEquals(read.dataDir, "/d/b")
    assertEquals(read.zenohWebUrl, null)
})

Deno.test("older Desktops: flags and env", () => {
    const read = withEnv(
        { DIMOS_APP_NAME: "a", DIMOS_APP_DATA: "/d/a" },
        () =>
            readDimosApp([
                "--socket",
                "/s/a.sock",
                "--desktop-url",
                "http://127.0.0.1:7341",
                "--zenoh-connect",
                "",
            ]),
    )
    assertEquals(read.version, 0)
    assertEquals(read.name, "a")
    assertEquals(read.socket, "/s/a.sock")
    assertEquals(read.path, "/apps/a/")
    assertEquals(read.url, "http://127.0.0.1:7341/apps/a/")
    assertEquals(read.dataDir, "/d/a")
    assertEquals(read.zenohConnect, "")
})
