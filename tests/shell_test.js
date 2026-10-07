// deno test shell_test.js
import { assertEquals } from "jsr:@std/assert@1"
import { runCommand, runShell } from "../source/shell.js"

Deno.test("runShell outside Desktop runs nothing", async () => {
    assertEquals((await runShell({ title: "x", commands: [{ run: "true" }] })).status, "unavailable")
})

function fakeDesktop(answers) {
    const seen = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, init) => {
        seen.push([init.method, String(url), init.body ? JSON.parse(init.body) : undefined])
        return Promise.resolve(new Response(JSON.stringify(answers.shift())))
    }
    return { seen, restore: () => (globalThis.fetch = realFetch) }
}

Deno.test("runShell posts the request, then polls until it finishes", async () => {
    const done = { status: "succeeded", commands: [{ run: "id -u", status: "done", exitCode: 0, stdout: "501\n" }] }
    const desktop = fakeDesktop([{ id: "sh-1" }, { status: "pending", commands: [] }, done])
    const updates = []
    try {
        const result = await runShell(
            { title: "Who", app: "my_app", commands: [{ run: "id -u", needsStdout: true }] },
            { origin: "http://127.0.0.1:7000", onUpdate: (s) => updates.push(s.status) },
        )
        assertEquals(result.commands[0].stdout, "501\n")
        assertEquals(updates, ["pending", "succeeded"])
        assertEquals(desktop.seen[0], [
            "POST",
            "http://127.0.0.1:7000/api/desktop/shell",
            { title: "Who", app: "my_app", commands: [{ run: "id -u", needsStdout: true }] },
        ])
        assertEquals(desktop.seen[1].slice(0, 2), ["GET", "http://127.0.0.1:7000/api/desktop/shell/sh-1?wait=25"])
    } finally {
        desktop.restore()
    }
})

Deno.test("runCommand answers the one command's result", async () => {
    const desktop = fakeDesktop([{ id: "sh-2" }, {
        status: "cancelled",
        reason: "nobody pressed Run within 600 s",
        commands: [{ run: "sudo true", status: "pending", exitCode: null }],
    }])
    try {
        const result = await runCommand("sudo true", { title: "t", note: "n" }, { origin: "http://h" })
        assertEquals([result.status, result.exitCode, result.reason], [
            "cancelled",
            null,
            "nobody pressed Run within 600 s",
        ])
        assertEquals(desktop.seen[0][2].commands, [{ run: "sudo true", note: "n" }])
    } finally {
        desktop.restore()
    }
})
