// Types for dim_app.js
import type { AppZenoh, GetZenohOptions, SubscribeOptions } from "./zenoh.d.ts"

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
    /** "<pkg>.<Type>" from the key, or null */
    type: string | null
    receivedAt: number
}
export interface DimSubscribeOptions extends SubscribeOptions {
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
export interface DimAppOptions extends GetZenohOptions {
    /** the codec module's URL, relative to the page or absolute, e.g. "../../dimos/msgs.js" */
    msgDecodeEndpoint: string
    /** an already-imported codec module (skips the import) */
    msgs?: MsgsModule
}
export function dimosKey(topic: string): string
export class DimApp {
    constructor(options: DimAppOptions)
    readonly msgDecodeEndpoint: string | null
    readonly zenoh: AppZenoh
    readonly msgs: MsgsModule | null
    readonly msgsReady: Promise<MsgsModule | null>
    subscribe<T = unknown>(
        topic: string,
        callback: (message: T | Uint8Array, info: MessageInfo) => void,
        options?: DimSubscribeOptions,
    ): () => void
    publish(topic: string, type: string | MsgType, value: unknown): Promise<void>
    publisher(topic: string, type: string | MsgType, options?: Record<string, unknown>): Promise<DimPublisher>
}
