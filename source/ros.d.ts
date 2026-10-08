// Types for ros.js
export type RosDistro = "humble" | "iron" | "jazzy" | "kilted" | "lyrical"
export interface RosTypeCodec<T = unknown> {
    /** "pkg/msg/Type" */
    readonly name: string
    decode(bytes: Uint8Array): T
    encode(value: unknown): Uint8Array
}
export interface RosCodec {
    readonly distro: RosDistro
    /** true once Foxglove's modules are in (sync() works) */
    readonly loaded: boolean
    load(): Promise<RosCodec>
    has(type: string): boolean
    sync<T = unknown>(type: string): RosTypeCodec<T>
    decode<T = unknown>(type: string, bytes: Uint8Array): Promise<T>
    encode(type: string, value: unknown): Promise<Uint8Array>
    /** adds a type from its .msg text */
    define(type: string, msgText: string): Promise<void>
}
export const ROS_MODULES: { serialization: string; definitions: string; parser: string }
export const ROS_DISTROS: RosDistro[]
/** "pkg/msg/Type" for "pkg/msg/Type", "pkg/Type" or "pkg::msg::dds_::Type_"; null otherwise */
export function rosTypeName(name: string): string | null
/** the ROS type an rmw_zenoh key or a CDR encoding with a schema names, or null */
export function rosTypeOfSample(key: string, encoding?: string): string | null
export function rosCodec(options?: { distro?: RosDistro }): RosCodec
