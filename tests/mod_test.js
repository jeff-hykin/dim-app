// deno test -A tests/mod_test.js
import { assertEquals } from "jsr:@std/assert@1"
import * as mod from "../mod.js"
import { DimApp } from "../source/dim_app.js"
import { getZenoh } from "../source/zenoh.js"

Deno.test("mod.js: loads in Deno and re-exports the source files' API", () => {
    assertEquals(mod.DimApp, DimApp)
    assertEquals(mod.getZenoh, getZenoh)
    for (const name of ["DimAppBackend", "DimAppFrontend", "initTheme", "notify", "runShell", "openApp", "appEvents"]) {
        assertEquals(typeof mod[name], "function", name)
    }
})
