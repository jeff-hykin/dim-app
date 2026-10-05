// Shell commands (sudo ones too) run through dimOS Desktop (POST /api/desktop/shell, Desktop's docs/shell.md). Desktop
// shows the commands over the app and nothing runs until the user presses Run; they run in one terminal, so sudo asks
// for the password once; when one fails, the user or Desktop's agent fixes it in that terminal and retries it.
//
//     import { runShell } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.13.1/shell.js"
//     const result = await runShell({
//         title: "Fix LAN discovery",
//         message: "A VPN took the route the Go2 probe needs.",
//         commands: [
//             { run: "sudo route -n add -host 231.1.1.1 -interface en0", note: "Send the probe over Wi-Fi" },
//             { run: "route -n get 231.1.1.1", note: "Check the route", needsStdout: true },
//         ],
//     })
//     if (result.status === "succeeded") { console.log(result.commands[1].stdout) }
//
// Resolves when it finishes: status "succeeded", "failed" (the user gave up after a failure) or "cancelled" (before or
// while running, or nobody pressed Run within `timeout` seconds), with each command's exitCode, output (what the
// terminal showed) and, for needsStdout, its stdout and stderr apart. Outside Desktop (and with no `origin`) nothing
// runs: it resolves to status "unavailable". A Deno backend passes Desktop's URL: `{ origin: dimContext().desktopUrl }`
// (and `app`, its install name, so the modal sits over its page).

const FINISHED = ["succeeded", "failed", "cancelled"]

function appName() {
    try {
        const meta = document.querySelector('meta[name="dim-app"]')
        if (meta?.content) {
            return meta.content
        }
        const match = location.pathname.match(/^\/apps\/([^/]+)/)
        return match ? decodeURIComponent(match[1]) : null
    } catch {
        return null
    }
}

function underDesktop() {
    try {
        return /^\/apps\/[^/]+/.test(location.pathname)
    } catch {
        return false
    }
}

async function call(origin, method, path, body) {
    const response = await fetch(new URL(path, origin), {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
        throw new Error(`Desktop answered ${response.status}: ${data.error ?? ""}`)
    }
    return data
}

/**
 * Asks Desktop to run `commands` and waits for the result.
 * @param {{ title: string, message?: string, app?: string, timeout?: number,
 *           commands: Array<{ run: string, note?: string, needsStdout?: boolean, cwd?: string, env?: Record<string, string> }> }} request
 * @param {{ origin?: string, onUpdate?: (session: object) => void, signal?: AbortSignal }} [options]
 *     onUpdate: the session after each poll (status pending → running → blocked …); signal: aborting cancels it
 */
export async function runShell(request, options = {}) {
    if (!options.origin && !underDesktop()) {
        return { status: "unavailable", reason: "not under dimOS Desktop", commands: [] }
    }
    const origin = options.origin ?? location.origin
    const app = request.app ?? appName() ?? undefined
    const { id } = await call(origin, "POST", "/api/desktop/shell", { ...request, app })
    const path = `/api/desktop/shell/${encodeURIComponent(id)}`
    const cancel = () => call(origin, "POST", `${path}/cancel`).catch(() => {})
    options.signal?.addEventListener("abort", cancel, { once: true })
    try {
        while (true) {
            const session = await call(origin, "GET", `${path}?wait=25`)
            options.onUpdate?.(session)
            if (FINISHED.includes(session.status)) {
                return session
            }
            if (options.signal?.aborted) {
                await cancel()
            }
        }
    } finally {
        options.signal?.removeEventListener("abort", cancel)
    }
}

/**
 * One command; resolves to its result (`{ status, exitCode, output, stdout?, stderr? }`) plus the session's `status`.
 * @param {string} run
 * @param {{ title: string, note?: string, message?: string, needsStdout?: boolean, app?: string, timeout?: number }} details
 * @param {{ origin?: string, onUpdate?: (session: object) => void, signal?: AbortSignal }} [options]
 */
export async function runCommand(run, details, options) {
    const { note, needsStdout, ...request } = details
    const session = await runShell({ ...request, commands: [{ run, note, needsStdout }] }, options)
    return { ...(session.commands[0] ?? {}), status: session.status, reason: session.reason }
}
