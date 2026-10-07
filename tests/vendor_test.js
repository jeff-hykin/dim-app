// deno test -A tests/vendor_test.js
import { assert, assertEquals } from "jsr:@std/assert@1"

const vendor = new URL("../tools/vendor.js", import.meta.url).pathname
const run = async (folder) => {
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--no-lock", vendor, folder],
        stdout: "piped",
        stderr: "piped",
    }).output()
    assertEquals(code, 0, new TextDecoder().decode(stderr))
    return new TextDecoder().decode(stdout)
}
const exists = (path) => Deno.stat(path).then(() => true, () => false)

Deno.test("vendor.js: mod.js brings every source file it re-exports, in source/", async () => {
    const folder = await Deno.makeTempDir()
    try {
        await Deno.writeTextFile(`${folder}/mod.js`, "")
        await run(folder)
        const mod = await Deno.readTextFile(`${folder}/mod.js`)
        assert(mod.includes('from "./source/dim_app.js"'))
        for (const file of ["dim_app.js", "zenoh.js", "topic.js", "theme.js", "frontend.js", "ui.js", "binary.js"]) {
            assert(await exists(`${folder}/source/${file}`), file)
        }
        assert(!(await exists(`${folder}/source/zenoh.d.ts`)), "no .d.ts unless the app keeps types")
    } finally {
        await Deno.remove(folder, { recursive: true })
    }
})

Deno.test("vendor.js: a pre-0.18 flat folder moves into source/ (with fonts); an app's own file stays", async () => {
    const folder = await Deno.makeTempDir()
    try {
        for (const file of ["zenoh.js", "zenoh.d.ts", "theme.css", "my_own.js"]) {
            await Deno.writeTextFile(`${folder}/${file}`, "old")
        }
        await Deno.mkdir(`${folder}/fonts`)
        await run(folder)
        for (const file of ["zenoh.js", "zenoh.d.ts", "topic.js", "topic.d.ts", "theme.css"]) {
            assert(await exists(`${folder}/source/${file}`), file)
        }
        assert((await Array.fromAsync(Deno.readDir(`${folder}/source/fonts`))).length > 0, "theme.css's fonts")
        assert(!(await exists(`${folder}/zenoh.js`)) && !(await exists(`${folder}/fonts`)))
        assertEquals(await Deno.readTextFile(`${folder}/my_own.js`), "old")
    } finally {
        await Deno.remove(folder, { recursive: true })
    }
})

Deno.test("vendor.js: the import examples in a file's comments aren't fetched", async () => {
    const folder = await Deno.makeTempDir()
    try {
        await Deno.mkdir(`${folder}/source`)
        await Deno.writeTextFile(`${folder}/source/dim_app.js`, "")
        const out = await run(folder)
        assert(await exists(`${folder}/source/zenoh_gateway_client.js`), "a real dynamic import still comes along")
        assert(!out.includes("skip"), out)
    } finally {
        await Deno.remove(folder, { recursive: true })
    }
})
