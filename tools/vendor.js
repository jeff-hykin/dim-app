#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net
// Refreshes an app's vendored copy of dim-app (the files already in that folder) from the dim-app version this script
// was loaded from, so the version an app pins is the URL it ran:
//
//     deno run -A https://raw.githubusercontent.com/jeff-hykin/dim-app/v0.18.1/tools/vendor.js frontend/src/dim-app
//
// The folder mirrors the repo: `mod.js` (everything) and/or `source/<file>` (one file and what it imports). A new app:
// create the files it wants (e.g. `touch mod.js`, or `mkdir source; touch source/theme.css source/theme.js`), then run
// it. A folder from before v0.18.0 (files at its top, e.g. `dim-app/zenoh.js`) is moved into `source/`: its imports
// then need `dim-app/source/zenoh.js` (or `dim-app/mod.js`).
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
    const source = new URL("../source/first_paint.html", import.meta.url)
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
const repo = new URL("../", import.meta.url)
const exists = async (path) => {
    try {
        await Deno.stat(path)
        return true
    } catch {
        return false
    }
}
/** `path` (relative to `from`, both inside the repo) as a repo-relative path */
const resolve = (path, from) => new URL(path, new URL(from, repo)).href.slice(repo.href.length)

const wanted = []
const moved = []
for await (const entry of Deno.readDir(folder)) {
    if (entry.isFile && entry.name === "mod.js") {
        wanted.push("mod.js")
    } else if (entry.isFile) {
        // from before v0.18.0: dim-app's files sat at the folder's top
        wanted.push(`source/${entry.name}`)
        moved.push(entry.name)
    } else if (entry.isDirectory && entry.name === "fonts") {
        moved.push(entry.name)
    }
}
if (await exists(`${folder}/source`)) {
    for await (const entry of Deno.readDir(`${folder}/source`)) {
        if (entry.isFile) {
            wanted.push(`source/${entry.name}`)
        }
    }
}
// a file's relative imports come along (e.g. react.js → desktop.js), with their .d.ts when the app keeps types
const wantTypes = wanted.some((path) => path.endsWith(".d.ts"))
const queue = wanted.sort()
const done = new Set()
const written = new Set()
while (queue.length) {
    const path = queue.shift()
    if (done.has(path)) {
        continue
    }
    done.add(path)
    const source = new URL(path, repo)
    // a file:// copy of dim-app throws for a missing file where https answers 404
    const response = await fetch(source).catch(() => new Response(null, { status: 404 }))
    if (!response.ok) {
        if (!path.endsWith(".d.ts") || wanted.includes(path)) {
            console.log(`skip ${path} (not in dim-app: ${response.status})`)
        }
        await response.body?.cancel()
        continue
    }
    const target = `${folder}/${path}`
    await Deno.mkdir(target.split("/").slice(0, -1).join("/"), { recursive: true })
    if (path.endsWith(".woff2")) {
        await Deno.writeFile(target, new Uint8Array(await response.arrayBuffer()))
        written.add(path)
        console.log(`${path} ← ${source.href}`)
        continue
    }
    const text = await response.text()
    await Deno.writeTextFile(target, text)
    written.add(path)
    console.log(`${path} ← ${source.href}`)
    if (path.endsWith(".js")) {
        // the usage examples in a file's comments ("./dim-app/source/zenoh.js") aren't its imports
        const code = text.replace(/^\s*\/\/.*$/gm, "")
        for (const [, dependency] of code.matchAll(/(?:from|import\()\s*"(\.\/[\w./-]+\.js)"/g)) {
            const dependencyPath = resolve(dependency, path)
            queue.push(dependencyPath)
            if (wantTypes) {
                queue.push(dependencyPath.replace(/\.js$/, ".d.ts"))
            }
        }
    }
    // the files a stylesheet points at (theme.css's bundled fonts) come along
    if (path.endsWith(".css")) {
        for (const [, file] of text.matchAll(/url\("(\.\/[^"]+)"\)/g)) {
            queue.push(resolve(file, path))
        }
    }
}
for (const name of moved) {
    const copied = [...written].some((path) => path === `source/${name}` || path.startsWith(`source/${name}/`))
    if (!copied) {
        continue // not one of dim-app's files: left where it is
    }
    await Deno.remove(`${folder}/${name}`, { recursive: true })
    console.log(`moved ${name} → source/${name}: import it as dim-app/source/${name} (or dim-app/mod.js)`)
}
