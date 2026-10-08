// deno test -A tests/ros_test.js (the codec tests import Foxglove's modules from esm.sh: skipped offline)
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1"
import { ROS_MODULES, rosCodec, rosTypeName, rosTypeOfSample } from "../source/ros.js"
import { DimApp } from "../source/dim_app.js"
import { fakes, tick } from "./test_fakes.js"

const online = await fetch(ROS_MODULES.definitions, { signal: AbortSignal.timeout(5000) })
    .then(async (response) => (await response.body?.cancel(), response.ok))
    .catch(() => false)
const onlineTest = (name, fn) => Deno.test({ name, ignore: !online, fn })

Deno.test("rosTypeName: every spelling of a ROS type", () => {
    assertEquals(rosTypeName("sensor_msgs/msg/Image"), "sensor_msgs/msg/Image")
    assertEquals(rosTypeName("sensor_msgs/Image"), "sensor_msgs/msg/Image")
    assertEquals(rosTypeName("sensor_msgs::msg::dds_::Image_"), "sensor_msgs/msg/Image")
    assertEquals(rosTypeName("geometry_msgs.Twist"), null)
    assertEquals(rosTypeName("nope"), null)
})

Deno.test("rosTypeOfSample: rmw_zenoh keys and CDR encodings name the type; dimos keys don't", () => {
    assertEquals(
        rosTypeOfSample(
            "0/robot1/odom/nav_msgs::msg::dds_::Odometry_/RIHS01_3cc97dc7fb7502f8714462c526d369e35b603cfc34d946e3f2eda2766dfec6e0",
        ),
        "nav_msgs/msg/Odometry",
    )
    assertEquals(rosTypeOfSample("chatter", "application/cdr;std_msgs/msg/String"), "std_msgs/msg/String")
    assertEquals(rosTypeOfSample("chatter", "zenoh/bytes;std_msgs/msg/String"), null)
    assertEquals(rosTypeOfSample("dimos/odom/nav_msgs.Odometry"), null)
    assertEquals(rosTypeOfSample("chatter"), null)
})

/** A value as the reader gives it back: typed arrays as plain arrays, for comparing */
const plain = (value) =>
    JSON.parse(JSON.stringify(value, (_, v) => (ArrayBuffer.isView(v) ? [...v] : typeof v === "bigint" ? `${v}n` : v)))

const ROUND_TRIPS = {
    "std_msgs/msg/String": { data: "hello ros" },
    "geometry_msgs/msg/Twist": { linear: { x: 0.3, y: 0, z: 0 }, angular: { x: 0, y: 0, z: -1.5 } },
    "sensor_msgs/msg/Image": {
        header: { stamp: { sec: 12, nanosec: 345 }, frame_id: "camera" },
        height: 2,
        width: 3,
        encoding: "rgb8",
        is_bigendian: 0,
        step: 9,
        data: new Uint8Array([...Array(18).keys()]),
    },
    "nav_msgs/msg/Odometry": {
        header: { stamp: { sec: 1, nanosec: 2 }, frame_id: "odom" },
        child_frame_id: "base_link",
        pose: {
            pose: { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0.5, w: 0.75 } },
            covariance: new Float64Array(36).fill(0.25),
        },
        twist: {
            twist: { linear: { x: 0.5, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0.1 } },
            covariance: new Float64Array(36),
        },
    },
    "tf2_msgs/msg/TFMessage": {
        transforms: [
            {
                header: { stamp: { sec: 5, nanosec: 6 }, frame_id: "map" },
                child_frame_id: "odom",
                transform: { translation: { x: 1, y: -1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
            },
            {
                header: { stamp: { sec: 5, nanosec: 7 }, frame_id: "odom" },
                child_frame_id: "base_link",
                transform: { translation: { x: 0.2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 1, w: 0 } },
            },
        ],
    },
}

onlineTest(
    "ros: CDR round trips for standard types (std_msgs, geometry_msgs, sensor_msgs, nav_msgs, tf2_msgs)",
    async () => {
        const ros = rosCodec()
        for (const [type, value] of Object.entries(ROUND_TRIPS)) {
            const bytes = await ros.encode(type, value)
            assertEquals([...bytes.subarray(0, 2)], [0, 1], `${type}: CDR little-endian encapsulation header`)
            assertEquals(plain(await ros.decode(type, bytes)), plain(value), type)
        }
        // every spelling decodes the same
        const bytes = await ros.encode("std_msgs/String", { data: "x" })
        assertEquals((await ros.decode("std_msgs::msg::dds_::String_", bytes)).data, "x")
        assert(ros.has("visualization_msgs/msg/MarkerArray"))
    },
)

onlineTest("ros: known CDR bytes decode (std_msgs/String 'hi', as DDS sends it)", async () => {
    const bytes = new Uint8Array([0, 1, 0, 0, 3, 0, 0, 0, 104, 105, 0, 0])
    assertEquals(await rosCodec().decode("std_msgs/msg/String", bytes), { data: "hi" })
})

onlineTest("ros: unknown types fail with a hint; define() adds one from .msg text; distros", async () => {
    const ros = rosCodec({ distro: "humble" })
    await assertRejects(() => ros.encode("my_msgs/msg/Battery", {}), Error, "ros.define")
    await ros.define(
        "my_msgs/msg/Battery",
        "float32 percent\nstring name\ngeometry_msgs/Point where\nCell[] cells\nuint8 FULL=100\n================================================================================\nMSG: my_msgs/Cell\nfloat32 volts",
    )
    const value = { percent: 0.5, name: "main", where: { x: 1, y: 2, z: 3 }, cells: [{ volts: 3.5 }, { volts: 4 }] }
    assertEquals(await ros.decode("my_msgs/Battery", await ros.encode("my_msgs/msg/Battery", value)), value)
})

onlineTest(
    "DimApp.subscribeKey: rmw_zenoh keys decode as CDR (in order while the codec loads); dimos keys don't",
    async () => {
        const fake = fakes()
        const app = new DimApp({
            href: "http://h:7341/apps/my-app/",
            connect: fake.connect,
            fetch: fake.fetch,
            msgs: {},
        })
        try {
            await app.zenoh.ready
            const writer = rosCodec()
            const key =
                "0/chatter/std_msgs::msg::dds_::String_/RIHS01_df668c740482bbd48fb39d76a70dfd4bd59db1288021743503259e948f6b1a18"
            const seen = []
            app.subscribeKey("0/chatter/**", (message, info) => seen.push([message, info.type]), {
                delivery: "reliable",
            })
            await tick()
            const client = fake.clients[0]
            assertEquals(client.open()[0].options.delivery, "reliable")
            client.put(key, await writer.encode("std_msgs/msg/String", { data: "one" }))
            client.put(key, await writer.encode("std_msgs/msg/String", { data: "two" }))
            await app.ros.load()
            await tick()
            client.put(key, await writer.encode("std_msgs/msg/String", { data: "three" }))
            assertEquals(seen, [
                [{ data: "one" }, "std_msgs/msg/String"],
                [{ data: "two" }, "std_msgs/msg/String"],
                [{ data: "three" }, "std_msgs/msg/String"],
            ])
        } finally {
            app.zenoh.close()
        }
    },
)

onlineTest(
    "DimApp.subscribeKey: { rosType } for zenoh-bridge-ros2dds keys; a CDR encoding names the type",
    async () => {
        const fake = fakes()
        const app = new DimApp({
            href: "http://h:7341/apps/my-app/",
            connect: fake.connect,
            fetch: fake.fetch,
            msgs: {},
        })
        try {
            await app.zenoh.ready
            await app.ros.load()
            const seen = []
            app.subscribeKey("cmd_vel", (message, info) => seen.push([message, info.type]), {
                rosType: "geometry_msgs/msg/Twist",
            })
            app.subscribeKey("status", (message, info) => seen.push([message, info.type]))
            await tick()
            const twist = { linear: { x: 1, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 2 } }
            fake.clients[0].put("cmd_vel", await app.ros.encode("geometry_msgs/msg/Twist", twist))
            fake.clients[0].put(
                "status",
                await app.ros.encode("std_msgs/msg/Bool", { data: true }),
                "application/cdr;std_msgs/msg/Bool",
            )
            assertEquals(seen, [[twist, "geometry_msgs/msg/Twist"], [{ data: true }, "std_msgs/msg/Bool"]])
        } finally {
            app.zenoh.close()
        }
    },
)
