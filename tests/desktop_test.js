// deno test desktop_test.js
import { assertEquals } from "jsr:@std/assert@1"
import { appInstalled, openApp, underDesktop } from "../source/desktop.js"

const APPS = { apps: [{ name: "dim-controller", title: "Controller", url: "/apps/dim-controller/" }] }

/** Runs `body` as a page at `href`, with fetch / parent / open faked; returns what they saw. */
async function asPage(href, { framed = true } = {}, body) {
    const seen = { fetches: [], posts: [], opened: [] }
    const real = { fetch: globalThis.fetch, open: globalThis.open }
    const fakeParent = framed
        ? { location: { origin: new URL(href).origin }, postMessage: (data, origin) => seen.posts.push([data, origin]) }
        : globalThis
    Object.defineProperty(globalThis, "location", { value: new URL(href), configurable: true })
    Object.defineProperty(globalThis, "parent", { value: fakeParent, configurable: true })
    globalThis.fetch = (url, init) => {
        seen.fetches.push([String(url), init?.method ?? "GET", init?.body ? JSON.parse(init.body) : null])
        return Promise.resolve(new Response(JSON.stringify(APPS)))
    }
    globalThis.open = (url) => seen.opened.push(url)
    try {
        await body()
    } finally {
        globalThis.fetch = real.fetch
        globalThis.open = real.open
        delete globalThis.location
        delete globalThis.parent
    }
    return seen
}

Deno.test("outside Desktop nothing is installed or opened", async () => {
    assertEquals(underDesktop(), false)
    assertEquals(await appInstalled("launcher"), false)
    assertEquals(await openApp("launcher"), false)
})

Deno.test("appInstalled: built-ins always, apps by name or title", async () => {
    await asPage("http://127.0.0.1:7341/apps/dim-map-builder/", {}, async () => {
        assertEquals(await appInstalled("launcher"), true)
        assertEquals(await appInstalled("dim-controller", { fresh: true }), true)
        assertEquals(await appInstalled("controller"), true)
        assertEquals(await appInstalled("dim-go2-dash"), false)
    })
})

Deno.test("openApp in the shell: posts open_app with the install name; the Launcher gets its filters in its link", async () => {
    const seen = await asPage("http://127.0.0.1:7341/apps/dim-controller/", {}, async () => {
        assertEquals(await openApp("Controller", { path: "#record" }), true)
        assertEquals(
            await openApp("launcher", { query: "go2 nav", robot: "go2", stream: "cmd_vel", selected: "unitree-go2" }),
            true,
        )
        assertEquals(await openApp("launcher"), true)
        assertEquals(await openApp("dim-nope", {}), false)
    })
    assertEquals(seen.posts.map(([data]) => [data.app, data.path]), [
        ["dim-controller", "#record"],
        ["launcher", "?q=go2+nav&robot=go2&needs=cmd_vel&blueprint=unitree-go2"],
        ["launcher", null],
    ])
    assertEquals(seen.posts[0][0].dimosShell, 1)
    assertEquals(seen.fetches.filter(([, method]) => method !== "GET"), [])
})

Deno.test("openApp on its own page under Desktop opens /?app=<id> in a new tab", async () => {
    const seen = await asPage("http://127.0.0.1:7341/apps/dim-controller/", { framed: false }, async () => {
        assertEquals(await openApp("appstore"), true)
    })
    assertEquals(seen.opened, ["http://127.0.0.1:7341/?app=appstore"])
})
