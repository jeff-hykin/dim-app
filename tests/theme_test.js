// deno test theme_test.js
import { assertEquals } from "jsr:@std/assert@1"

// a page at /apps/my-app/ on Desktop's origin: a fake document (its computed style is what Desktop's /theme.css gives
// the current html[data-skin]), and localStorage
const storage = new Map()
const SKINS = {
    portal: { colorScheme: "dark", "--radius-lg": "0px" },
    vibeslop: { colorScheme: "dark", "--radius-lg": "16px" },
    research: { colorScheme: "light", "--radius-lg": "10px" },
}
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
}
const classes = new Set()
const head = []
Object.assign(globalThis, {
    document: {
        documentElement: root,
        head: { prepend: (node) => head.unshift(node) },
        body: { classList: { add: (c) => classes.add(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) } },
        fonts: { load: () => Promise.resolve(), ready: Promise.resolve() },
        querySelector: (selector) =>
            head.find((node) => selector === "link[data-dim-desktop-theme]" && node.rel) ?? null,
        createElement: () => ({ dataset: {}, addEventListener() {} }),
    },
    getComputedStyle: () => {
        const skin = SKINS[root.dataset.skin] ?? SKINS.portal
        return { colorScheme: skin.colorScheme, getPropertyValue: (name) => skin[name] ?? "" }
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

const { initTheme, onThemeChange, themeName, desktopSkin, corners } = await import("../source/theme.js")
const desktopSaves = (key, value) => {
    storage.set(key, value)
    dispatchEvent(Object.assign(new Event("storage"), { key }))
}

Deno.test("links Desktop's /theme.css once, and shows Portal with nothing saved", () => {
    assertEquals(initTheme(), "portal")
    initTheme()
    assertEquals(head.map((link) => link.href), ["/theme.css"])
    assertEquals([root.dataset.skin, root.dataset.dimTheme, classes.has("dark")], ["portal", "portal", true])
    assertEquals(attributes.has("data-dim-square"), true)
})

Deno.test("follows the skin Desktop saves, live: html[data-skin], and light/dark from the skin's color-scheme", () => {
    const seen = []
    onThemeChange((detail) => seen.push(detail))
    desktopSaves("portal.theme", "vibeslop")
    assertEquals([root.dataset.skin, desktopSkin(), themeName(), classes.has("dark")], [
        "vibeslop",
        "vibeslop",
        "portal",
        true,
    ])
    assertEquals(attributes.has("data-dim-square"), false)
    desktopSaves("portal.theme", "research")
    assertEquals([themeName(), root.dataset.dimTheme, classes.has("dark")], ["research", "research", false])
    assertEquals(seen.at(-1), { dark: false, theme: "research", skin: "research", corners: "theme" })
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
