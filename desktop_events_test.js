// deno test -A desktop_events_test.js
import { assertEquals } from "jsr:@std/assert@1"
import { onDesktopEvent, sseParser } from "./desktop_events.js"

Deno.test("sseParser: one event per blank line, split chunks, CRLF, multi-line data, ignores other fields", () => {
    const seen = []
    const feed = sseParser((data) => seen.push(data))
    feed(': keepalive\n\ndata: {"type":"ap')
    feed('ps"}\n\nevent: x\nid: 3\ndata:{"type":"runs"}\r\n\r\n')
    feed("data: line1\ndata: line2\n")
    assertEquals(seen, ['{"type":"apps"}', '{"type":"runs"}'])
    feed("\n")
    assertEquals(seen.at(-1), "line1\nline2")
})

Deno.test("onDesktopEvent (Deno): typed + '*' subscriptions, reconnects after the stream drops", async () => {
    let connections = 0
    const encoder = new TextEncoder()
    const server = Deno.serve({ port: 0, onListen() {} }, (request) => {
        assertEquals(new URL(request.url).pathname, "/api/events")
        connections += 1
        const first = connections === 1
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(
                    encoder.encode(first ? 'data: {"type":"apps"}\n\n' : 'data: {"type":"endpoints"}\n\n'),
                )
                if (first) {
                    controller.close() // drop: the client must reconnect
                }
            },
        })
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
    })
    const desktopUrl = `http://127.0.0.1:${server.addr.port}`
    const typed = []
    const all = []
    let resolveDone
    const done = new Promise((resolve) => (resolveDone = resolve))
    const offTyped = onDesktopEvent("endpoints", (event) => {
        typed.push(event.type)
        resolveDone()
    }, { desktopUrl })
    const offAll = onDesktopEvent("*", (event) => all.push(event.type), { desktopUrl })
    await done
    offTyped()
    offAll()
    assertEquals(typed, ["endpoints"])
    assertEquals(all, ["apps", "endpoints"])
    assertEquals(connections, 2)
    await server.shutdown()
})
