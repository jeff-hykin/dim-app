#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=git
// Refreshes source/msgs_fallback.js from a dimos checkout's generated codec (dimos/gateway/msgs/msgs.js):
//
//     deno run --allow-read --allow-write --allow-run=git tools/refresh_msgs_fallback.js ~/repos/dimos
const dimos = Deno.args[0]
if (!dimos) {
    console.error("usage: refresh_msgs_fallback.js <dimos checkout>")
    Deno.exit(1)
}
const git = async (...args) => {
    const { stdout } = await new Deno.Command("git", { args: ["-C", dimos, ...args], stdout: "piped" }).output()
    return new TextDecoder().decode(stdout).trim()
}
const source = `${dimos}/dimos/gateway/msgs/msgs.js`
const code = await Deno.readTextFile(source)
const commit = (await git("rev-parse", "--short=10", "HEAD")) || "unknown commit"
const dirty = (await git("status", "--porcelain", "--", "dimos/gateway/msgs/msgs.js")) ? " (uncommitted)" : ""
const header =
    `// dimos ${commit}${dirty} dimos/gateway/msgs/msgs.js, copied by tools/refresh_msgs_fallback.js; don't edit\n`
const target = new URL("../source/msgs_fallback.js", import.meta.url)
await Deno.writeTextFile(target, header + code)
console.log(`${target.pathname} ← ${source} @ ${commit}${dirty}`)
