// deno test theme_test.js
import { assertEquals } from "jsr:@std/assert@1"

// a page at /apps/my-app/ on Desktop's origin: a fake document, localStorage and Desktop's /api/ui-settings/themes
const storage = new Map()
const root = {
    dataset: {},
    style: {
        props: {},
        setProperty(k, v) {
            this.props[k] = v
        },
        removeProperty(k) {
            delete this.props[k]
        },
        getPropertyValue(k) {
            return this.props[k] ?? ""
        },
    },
}
const classes = new Set()
const fetched = []
let desktop = null
Object.assign(globalThis, {
    document: {
        documentElement: root,
        body: { classList: { add: (c) => classes.add(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) } },
        fonts: { load: () => Promise.resolve(), ready: Promise.resolve() },
    },
    parent: globalThis,
    fetch: (url) => {
        fetched.push(String(url))
        return Promise.resolve(desktop ? new Response(JSON.stringify(desktop)) : new Response("", { status: 503 }))
    },
})
Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    configurable: true,
})
Object.defineProperty(globalThis, "location", {
    value: new URL("http://127.0.0.1:5555/apps/my-app/"),
    configurable: true,
})

const { initTheme, onThemeChange, themeName, desktopSkin, corners } = await import("./theme.js")
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const desktopSaves = (key, value) => {
    storage.set(key, value)
    dispatchEvent(Object.assign(new Event("storage"), { key }))
}

Deno.test("follows Desktop: Portal with nothing to go on, then its saved theme and corners, live", async () => {
    const seen = []
    onThemeChange((detail) => seen.push(detail))
    assertEquals(initTheme(), "portal")
    assertEquals(fetched, ["http://127.0.0.1:5555/api/ui-settings/themes"])
    await tick()
    assertEquals([root.dataset.dimTheme, classes.has("dark"), root.dataset.corners], ["portal", true, undefined])

    desktopSaves("portal.theme", "research")
    assertEquals([themeName(), root.dataset.dimTheme, classes.has("dark")], ["research", "research", false])
    assertEquals(seen.at(-1), { dark: false, theme: "research", skin: "research", corners: "theme" })

    desktopSaves("portal.theme", "vibeslop")
    assertEquals([themeName(), desktopSkin()], ["portal", "vibeslop"])

    desktopSaves("portal.corners", "rounded")
    assertEquals([corners(), root.dataset.corners, root.style.props["--dim-corner-radius"]], [
        "rounded",
        "rounded",
        "10px",
    ])
    desktopSaves("portal.corners", "theme")
    assertEquals([root.dataset.corners, root.style.props["--dim-corner-radius"]], [undefined, undefined])
})

Deno.test("Desktop's answer says which skins are light, and is the theme when this browser saved none", async () => {
    storage.clear()
    desktop = {
        themes: [{ id: "portal", light: false }, { id: "paper", light: true }],
        current: "paper",
        corners: "sharp",
    }
    // (initTheme asks once; ask again the way a fresh page would)
    const fresh = await import("./theme.js?fresh")
    fresh.initTheme()
    await tick()
    await tick()
    assertEquals([fresh.themeName(), fresh.desktopSkin(), fresh.corners()], ["research", "paper", "sharp"])
    assertEquals(root.dataset.corners, "sharp")
})
