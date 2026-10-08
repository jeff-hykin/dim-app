// deno test -A tests/dimos_yaml_test.js
// dimos.yaml's `uses:` lists exactly the gateway/Desktop endpoints source/ calls: every path source/ names is listed,
// and every listed path is still named somewhere in source/.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { parse } from "jsr:@std/yaml@1"

const repo = new URL("../", import.meta.url)
const VENDORED = ["msgs_fallback.js", "zenoh_gateway_client.js"]
// an app's own endpoints (the consuming app serves them), not a gateway's
const OWN = [/^api\/state\//]
// the gateway prefixes as source/ writes them (relative to /apps/<name>/ or absolute), and the uses: group they go in
// (a bare `dimos/...` is a topic key, not a path)
const GATEWAY_PATH =
    /(?:(?:\.\.\/)*\/?(?:api|desktop)|(?:\.\.\/|\/)(?:dimos|agent))\/(?:\$\{[^}]*\}|[^\s"'`?)$])*|\/theme\.css/g
const GROUPS = [
    ["dimos/", "@dimos-gateway"],
    ["agent/", "@agentic-gateway"],
    ["", "@desktop-gateway"],
]

/** `/api/x/${id}` and `/api/x/{id}` → `/api/x/{}` */
const shape = (path) => path.replace(/\$\{[^}]*\}|\{[^}]*\}/g, "{}")

const yaml = parse(await Deno.readTextFile(new URL("dimos.yaml", repo)))
const listed = new Set()
for (const [group, value] of Object.entries(yaml.uses ?? {})) {
    for (const endpoint of Array.isArray(value) ? value : value?.endpoints ?? []) {
        const [, path] = endpoint.trim().split(/\s+/)
        listed.add(`${group} ${shape(path)}`)
    }
}

const used = new Map() // `group path` → where
let usesZenoh = false
for await (const entry of Deno.readDir(new URL("source/", repo))) {
    if (!entry.name.endsWith(".js") || VENDORED.includes(entry.name)) {
        continue
    }
    let text = await Deno.readTextFile(new URL(`source/${entry.name}`, repo))
    // `const path = \`/api/...\`` then `${path}/cancel`: put the literal in
    for (const [, name, literal] of text.matchAll(/const (\w+) = [`"]([^`"]*)[`"]/g)) {
        text = text.replaceAll("${" + name + "}", literal)
    }
    usesZenoh ||= text.includes("zenoh_gateway_client.js")
    text.split("\n").forEach((line, index) => {
        const code = line.trim()
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) {
            return
        }
        const found = [...line.matchAll(GATEWAY_PATH)].map((match) => match[0])
        if (/new URL\("\/",/.test(line)) {
            found.push("/") // Desktop's page: openApp's /?app=<id>
        }
        for (const raw of found) {
            const path = raw.replace(/^(\.\.\/)+/, "").replace(/^\//, "")
            if (OWN.some((own) => own.test(path))) {
                continue
            }
            const [prefix, group] = GROUPS.find(([prefix]) => path.startsWith(prefix))
            const key = `${group} ${shape("/" + path.slice(prefix.length))}`
            used.set(key, used.get(key) ?? `source/${entry.name}:${index + 1}`)
        }
    })
}

Deno.test("dimos.yaml: spec-version v1.0, uses: only (a library: no provides, nix or start)", () => {
    assertEquals(yaml["spec-version"], "v1.0")
    assertEquals(Object.keys(yaml).sort(), ["spec-version", "uses"])
})

Deno.test("dimos.yaml: every endpoint source/ calls is in uses:", () => {
    const missing = [...used].filter(([key]) => !listed.has(key)).map(([key, where]) => `${key} (${where})`)
    assertEquals(missing, [], "add these to dimos.yaml's uses:")
})

Deno.test("dimos.yaml: every endpoint in uses: is still called by source/", () => {
    assertEquals([...listed].filter((key) => !used.has(key)), [], "source/ no longer calls these")
})

Deno.test("dimos.yaml: @zenoh-gateway iff source/ uses the zenoh-gateway client", () => {
    assert(usesZenoh)
    assertEquals("@zenoh-gateway" in yaml.uses, usesZenoh)
})
