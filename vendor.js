#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net
// Refreshes an app's vendored copy of dim-app (the files already in that folder) from the dim-app version this script
// was loaded from, so the version an app pins is the URL it ran:
//
//     deno run -A https://raw.githubusercontent.com/jeff-hykin/dim-app/v0.9.3/vendor.js frontend/src/dim-app
//
// A new app: create the folder with the files it wants (e.g. `touch theme.css theme.js theme.d.ts`), then run it.
const folder = Deno.args[0]
if (!folder) {
    console.error("usage: vendor.js <folder holding the app's dim-app files>")
    Deno.exit(1)
}
const names = []
for await (const entry of Deno.readDir(folder)) {
    if (entry.isFile) {
        names.push(entry.name)
    }
}
for (const name of names.sort()) {
    const source = new URL(name, import.meta.url)
    const response = await fetch(source)
    if (!response.ok) {
        console.log(`skip ${name} (not in dim-app: ${response.status})`)
        await response.body?.cancel()
        continue
    }
    await Deno.writeTextFile(`${folder}/${name}`, await response.text())
    console.log(`${name} ← ${source.href}`)
}
