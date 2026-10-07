#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net
// Refreshes an app's vendored copy of dim-app (the files already in that folder) from the dim-app version this script
// was loaded from, so the version an app pins is the URL it ran:
//
//     deno run -A https://raw.githubusercontent.com/jeff-hykin/dim-app/v0.18.0/vendor.js frontend/src/dim-app
//
// A new app: create the folder with the files it wants (e.g. `touch theme.css theme.js theme.d.ts`), then run it.
//
// --index <path to the app's index.html>: also writes dim-app's first-paint block (first_paint.html: the theme's page
// color before any CSS or JS loads, so the app never flashes white) into that page, replacing the block it has or
// inserting it at the top of <head>.
const indexAt = Deno.args.indexOf("--index")
const indexPath = indexAt >= 0 ? Deno.args[indexAt + 1] : null
const folder = Deno.args.find((arg, i) => !arg.startsWith("--") && (indexAt < 0 || i !== indexAt + 1))
if (!folder || (indexAt >= 0 && !indexPath)) {
    console.error("usage: vendor.js <folder holding the app's dim-app files> [--index <app's index.html>]")
    Deno.exit(1)
}
if (indexPath) {
    const source = new URL("first_paint.html", import.meta.url)
    const response = await fetch(source)
    if (!response.ok) {
        throw new Error(`${source.href}: ${response.status}`)
    }
    const block = (await response.text()).trim()
    const html = await Deno.readTextFile(indexPath)
    const start = html.indexOf("<!-- dim-app first-paint")
    const endMark = "<!-- /dim-app first-paint -->"
    const end = html.indexOf(endMark)
    let next
    if (start >= 0 && end > start) {
        const indent = html.slice(html.lastIndexOf("\n", start) + 1, start)
        next = html.slice(0, start) + block.split("\n").join("\n" + indent) + html.slice(end + endMark.length)
    } else {
        // first in <head> after <meta charset> (when there is one), so it runs before any stylesheet or script
        const head = html.search(/<head[^>]*>/i)
        if (head < 0) {
            throw new Error(`${indexPath}: no <head>`)
        }
        const charset = html.slice(head).search(/<meta\s+charset[^>]*>/i)
        const at = charset >= 0
            ? head + charset + html.slice(head + charset).indexOf(">") + 1
            : head + html.slice(head).indexOf(">") + 1
        const indent = (html.slice(0, at).match(/\n([ \t]*)<[^\n]*$/) || [, "    "])[1]
        next = html.slice(0, at) + "\n" + block.split("\n").map((line) => indent + line).join("\n") + html.slice(at)
    }
    await Deno.writeTextFile(indexPath, next)
    console.log(`first-paint block → ${indexPath}`)
}
const names = []
for await (const entry of Deno.readDir(folder)) {
    if (entry.isFile && !entry.name.endsWith(".woff2")) {
        names.push(entry.name)
    }
}
// a file's relative imports come along (e.g. react.js → desktop.js), with their .d.ts when the app keeps types
const wantTypes = names.some((name) => name.endsWith(".d.ts"))
const queue = names.sort()
const done = new Set()
while (queue.length) {
    const name = queue.shift()
    if (done.has(name)) {
        continue
    }
    done.add(name)
    const source = new URL(name, import.meta.url)
    const response = await fetch(source)
    if (!response.ok) {
        if (!name.endsWith(".d.ts") || names.includes(name)) {
            console.log(`skip ${name} (not in dim-app: ${response.status})`)
        }
        await response.body?.cancel()
        continue
    }
    const text = await response.text()
    await Deno.writeTextFile(`${folder}/${name}`, text)
    console.log(`${name} ← ${source.href}`)
    if (name.endsWith(".js")) {
        for (const [, dependency] of text.matchAll(/(?:from|import\()\s*"\.\/([\w.-]+\.js)"/g)) {
            queue.push(dependency)
            if (wantTypes) {
                queue.push(dependency.replace(/\.js$/, ".d.ts"))
            }
        }
    }
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
