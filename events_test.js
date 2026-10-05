// deno test -A events_test.js
import { assertEquals } from "jsr:@std/assert@1"
import { appEvents } from "./events.js"
import { getZenoh } from "./zenoh.js"
import { fakes, INFO, tick } from "./test_fakes.js"

Deno.test("appEvents: the frontend topic `events`, onOpen on connect and reconnect, onClose when lost", async () => {
    const fake = fakes()
    const zenoh = getZenoh({ href: "http://h/apps/my-app/", connect: fake.connect, fetch: fake.fetch })
    const log = []
    const stop = appEvents((event) => log.push(event.type), {
        onOpen: () => log.push("open"),
        onClose: ({ wasOpen }) => log.push(`close:${wasOpen}`),
    })
    await zenoh.ready
    await tick()
    const client = fake.clients[0]
    client.put(`${INFO.zenohPrefix}/frontend/events`, { type: "a" })
    client.setState("lost")
    client.setState("connected")
    client.put(`${INFO.zenohPrefix}/frontend/events`, { type: "b" })
    assertEquals(log, ["open", "a", "close:true", "open", "b"])
    stop()
    assertEquals(client.open().length, 0)
    zenoh.close()
})
