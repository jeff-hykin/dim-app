#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net
// Re-vendors zenoh-gateway's browser client (client/zenoh_gateway.ts and its client/vendor/fzstd.ts) at a commit into
// source/vendor/zenoh-gateway/, as plain JS (types stripped by TypeScript's transpileModule, comments kept), so pages
// load it with no build and no network fetch:
//
//     deno run -A tools/vendor_zenoh_client.js <commit> [--repo <path or git url of zenoh-gateway>]
//
// Pick the commit Desktop's gateway is built from, then bump dimos.yaml's @zenoh-gateway range if the gateway changed.
import ts from "npm:typescript@5.9.3"

const repoAt = Deno.args.indexOf("--repo")
const upstream = repoAt >= 0 ? Deno.args[repoAt + 1] : "https://github.com/jeff-hykin/zenoh-gateway"
const commit = Deno.args.find((arg, i) => !arg.startsWith("--") && (repoAt < 0 || i !== repoAt + 1))
if (!commit) {
    console.error("usage: vendor_zenoh_client.js <commit> [--repo <path or git url of zenoh-gateway>]")
    Deno.exit(1)
}
const git = async (...args) => {
    const { code, stdout, stderr } = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output()
    if (code !== 0) {
        throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`)
    }
    return new TextDecoder().decode(stdout).trim()
}

const checkout = await Deno.makeTempDir()
try {
    await git("clone", "--quiet", upstream, checkout)
    await git("-C", checkout, "checkout", "--quiet", commit)
    const full = await git("-C", checkout, "rev-parse", "HEAD")
    const short = full.slice(0, 7)
    const target = new URL("../source/vendor/zenoh-gateway/", import.meta.url).pathname
    await Deno.remove(target, { recursive: true }).catch(() => {})
    await Deno.mkdir(`${target}vendor`, { recursive: true })

    const transpile = (path) => {
        const source = Deno.readTextFileSync(`${checkout}/${path}`)
        const { outputText } = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false },
        })
        // triple-slash lib references (no-default-lib, dom) would change an importing app's type checking
        return outputText.replace(/^\/\/\/ <reference [^\n]*\n/gm, "").replace(/(from\s*"\.[^"]*)\.ts"/g, '$1.js"')
    }
    const header = (path, license) =>
        [
            "// deno-lint-ignore-file",
            "// deno-fmt-ignore-file",
            "// @ts-nocheck",
            `// ${upstream} ${path} at ${short} (${full}), types stripped by tools/vendor_zenoh_client.js; do not edit`,
            `// license: ${license}`,
            "",
        ].join("\n")

    await Deno.writeTextFile(
        `${target}zenoh_gateway.js`,
        header("client/zenoh_gateway.ts", "./LICENSE") + transpile("client/zenoh_gateway.ts"),
    )
    await Deno.writeTextFile(
        `${target}vendor/fzstd.js`,
        header("client/vendor/fzstd.ts", "./fzstd.LICENSE") + transpile("client/vendor/fzstd.ts"),
    )
    await Deno.copyFile(`${checkout}/LICENSE`, `${target}LICENSE`)
    await Deno.copyFile(`${checkout}/client/vendor/fzstd.LICENSE`, `${target}vendor/fzstd.LICENSE`)
    await Deno.writeTextFile(`${target}UPSTREAM`, `${upstream} ${full}\n`)
    console.log(`zenoh-gateway client at ${short} → source/vendor/zenoh-gateway/`)
} finally {
    await Deno.remove(checkout, { recursive: true })
}
