// Types for dim_app.js
import type { AppZenoh, GetZenohOptions, SubscribeOptions } from "./zenoh.d.ts"
import type { RosCodec, RosDistro } from "./ros.d.ts"

/** The codec module the dimos gateway serves (GET /msgs.js); see its msgs.ts for the per-message types. */
export interface MsgsModule {
    decodeChannel(key: string, bytes: Uint8Array): unknown
    typeOfChannel(key: string): string | undefined
    lookup(name: string): MsgType
    [name: string]: unknown
}
export interface MsgType<T = unknown> {
    readonly name: string
    decode(bytes: Uint8Array): T
    encode(value: unknown): Uint8Array
    zenohKey(topic: string): string
}
export interface MessageInfo {
    key: string
    /** "<pkg>.<Type>" from the key (dimos), "pkg/msg/Type" (ROS), or null */
    type: string | null
    receivedAt: number
}
export interface DimKeySubscribeOptions extends SubscribeOptions {
    /** decode every sample as this ROS 2 type (CDR), e.g. "std_msgs/msg/String" (for keys that don't name it) */
    rosType?: string
}
export interface DimSubscribeOptions extends DimKeySubscribeOptions {
    /** "<pkg>.<Type>": only that type's key */
    type?: string
}
/** Silent until the first put(); its deadman is armed only by a put of something other than the stop value. */
export interface DimPublisher {
    readonly key: string
    readonly type: string
    /** the gateway client's publisher, null until the first put() */
    readonly raw: unknown
    /** whether the gateway holds the deadman now (true after a drive put, false after the stop value or stop()) */
    readonly armed: boolean
    put(value: unknown): void
    /** puts `value` (default: the deadman's stop value) and disarms the deadman */
    stop(value?: unknown): Promise<void>
    /** stores the stop value; armed by the next put of anything else (needs connectOptions { heartbeatHz }) */
    setDeadman(value: unknown): Promise<void>
    clearDeadman(): Promise<void>
    onTripped(listener: (reason: string) => void): () => void
    close(): void
}
/** What `update()` may change on a running subscription; `null` puts an option back to its default. */
export interface SubscriptionUpdate {
    maxHz?: number | null
    minQuality?: number | null
    qualityToHzTradeoff?: number | null
    bandwidthPriority?: number | null
    maxBitrate?: number | null
    minResolutionScale?: number | null
    maxResolution?: [number, number] | null
    /** video: [min, max] ms the browser may hold a frame to smooth out jitter ([0, 0] = show at once) */
    playoutDelay?: [number, number] | null
    encodeOptions?: { quality?: number }
}
/** Calling it unsubscribes. */
export interface DimSubscription {
    (): void
    unsubscribe(): void
    /** changes the running subscription's options in place (same channel and video track) */
    update(changes: SubscriptionUpdate): Promise<void>
}
export interface DimAppOptions extends GetZenohOptions {
    /** the codec module's URL, relative to the page or absolute, e.g. "../../dimos/msgs.js" */
    msgDecodeEndpoint: string
    /** an already-imported codec module (skips the import) */
    msgs?: MsgsModule
    /** the standard ROS 2 definitions' version for `app.ros` (default "jazzy") */
    rosDistro?: RosDistro
}
export function dimosKey(topic: string): string
export class DimApp {
    constructor(options: DimAppOptions)
    readonly msgDecodeEndpoint: string | null
    readonly zenoh: AppZenoh
    readonly msgs: MsgsModule | null
    readonly msgsReady: Promise<MsgsModule | null>
    /** ROS 2 (CDR) messages; Foxglove's modules load on first use */
    readonly ros: RosCodec
    subscribe<T = unknown>(
        topic: string,
        callback: (message: T | Uint8Array, info: MessageInfo) => void,
        options?: DimSubscribeOptions,
    ): DimSubscription
    /** subscribe() for any key expression; samples whose key/encoding names a ROS type are decoded as CDR */
    subscribeKey<T = unknown>(
        key: string,
        callback: (message: T | Uint8Array, info: MessageInfo) => void,
        options?: DimKeySubscribeOptions,
    ): DimSubscription
    publish(topic: string, type: string | MsgType, value: unknown): Promise<void>
    publisher(topic: string, type: string | MsgType, options?: Record<string, unknown>): Promise<DimPublisher>
}
