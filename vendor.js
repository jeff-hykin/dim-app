#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net
// Refreshes an app's vendored copy of dim-app (the files already in that folder) from the dim-app version this script
// was loaded from, so the version an app pins is the URL it ran:
//
//     deno run -A https://raw.githubusercontent.com/jeff-hykin/dim-app/v0.9.5/vendor.js frontend/src/dim-app
//
// A new app: create the folder with the files it wants (e.g. `touch theme.css theme.js theme.d.ts`), then run it.
const folder = Deno.args[0]
if (!folder) {
    console.error("usage: vendor.js <folder holding the app's dim-app files>")
    Deno.exit(1)
}
const names = []
for await (const entry of Deno.readDir(folder)) {
    if (entry.isFile && !entry.name.endsWith(".woff2")) {
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
    const text = await response.text()
    await Deno.writeTextFile(`${folder}/${name}`, text)
    console.log(`${name} ← ${source.href}`)
    // the files a stylesheet points at (theme.css's bundled fonts) come along
    if (name.endsWith(".css")) {
        for (const [, path] of text.matchAll(/url\("\.\/([^"]+)"\)/g)) {
            const fileUrl = new URL(path, import.meta.url)
            const file = await fetch(fileUrl)
            if (!file.ok) {
                throw new Error(`${fileUrl.href}: ${file.status}`)
            }
            await Deno.mkdir(`${folder}/${path.split("/").slice(0, -1).join("/")}`, {
                recursive: true,
            })
            await Deno.writeFile(
                `${folder}/${path}`,
                new Uint8Array(await file.arrayBuffer()),
            )
            console.log(`${path} ← ${fileUrl.href}`)
        }
    }
}
