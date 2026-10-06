// deno test theme_test.js
import { assertEquals } from "jsr:@std/assert@1"

// a page at /apps/my-app/ on Desktop's origin: a fake document and localStorage
const storage = new Map()
const fakeStyle = () => ({
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
})
const attributes = new Set()
const root = {
    dataset: {},
    style: fakeStyle(),
    toggleAttribute(name, on) {
        on ? attributes.add(name) : attributes.delete(name)
    },
    removeAttribute(name) {
        attributes.delete(name)
    },
}
const classes = new Set()
const body = {
    classList: { add: (c) => classes.add(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) },
    style: fakeStyle(),
}
Object.assign(globalThis, {
    document: {
        documentElement: root,
        body,
        fonts: { load: () => Promise.resolve(), ready: Promise.resolve() },
    },
    parent: globalThis,
})
Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    configurable: true,
})
Object.defineProperty(globalThis, "location", {
    value: new URL("http://127.0.0.1:5555/apps/my-app/"),
    configurable: true,
})

const { initTheme, onThemeChange, themeName, desktopSkin, desktopTheme, corners } = await import("./theme.js")
const desktopSaves = (key, value) => {
    storage.set(key, value)
    dispatchEvent(Object.assign(new Event("storage"), { key }))
}
const publish = (skin, light, tokens) => desktopSaves("portal.themeTokens", JSON.stringify({ skin, light, tokens }))

Deno.test("nothing published: the bundled Portal, no tokens inline", () => {
    assertEquals(initTheme(), "portal")
    assertEquals([root.dataset.dimTheme, classes.has("dark"), root.dataset.dimTokens], ["portal", true, undefined])
    assertEquals(body.style.props, {})
    assertEquals(desktopTheme(), null)
})

Deno.test("Desktop's published tokens go inline on <body>, exactly, and follow every change live", () => {
    const seen = []
    onThemeChange((detail) => seen.push(detail))
    const vibeslop = { "--bg": "#171717", "--card": "#212121", "--radius-lg": "16px", "--sans": "Inter" }
    publish("vibeslop", false, vibeslop)
    assertEquals(body.style.props, vibeslop)
    assertEquals([themeName(), desktopSkin(), classes.has("dark")], ["portal", "vibeslop", true])
    assertEquals([root.dataset.dimTokens, attributes.has("data-dim-square"), root.style.props.background], [
        "vibeslop",
        false,
        "#171717",
    ])
    assertEquals(seen.at(-1).tokens, vibeslop)

    // a light skin: the light structural rules, and the last skin's tokens are all replaced
    publish("research", true, { "--bg": "#f5f4ef", "--radius-lg": "10px" })
    assertEquals(body.style.props, { "--bg": "#f5f4ef", "--radius-lg": "10px" })
    assertEquals([themeName(), root.dataset.dimTheme, classes.has("dark")], ["research", "research", false])

    // a square skin squares every corner (theme.css's html[data-dim-square] rule)
    publish("portal", false, { "--bg": "#05070d", "--radius-lg": "0px" })
    assertEquals([themeName(), attributes.has("data-dim-square")], ["portal", true])
})

Deno.test("Desktop's corners follow too", () => {
    desktopSaves("portal.corners", "rounded")
    assertEquals([corners(), root.dataset.corners, root.style.props["--dim-corner-radius"]], [
        "rounded",
        "rounded",
        "10px",
    ])
    desktopSaves("portal.corners", "theme")
    assertEquals([root.dataset.corners, root.style.props["--dim-corner-radius"]], [undefined, undefined])
})

Deno.test("unreadable tokens count as none: the bundled Portal again", () => {
    desktopSaves("portal.themeTokens", "{not json")
    assertEquals([desktopTheme(), body.style.props, root.dataset.dimTokens], [null, {}, undefined])
})
