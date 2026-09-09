// Binary app-bus frames.
//
// The bus is JSON text frames, which forces byte payloads (jpegs, point clouds)
// through base64: +33% on the wire and a string-churn tax on both ends. A binary
// frame carries the bytes untouched, with a tiny JSON header alongside:
//
//     [u32 LE header length][header JSON {k: kind, m: meta}][payload bytes]
//
// The broker forwards frames verbatim either way. An older SDK receiving a
// binary frame drops it in _dispatch (JSON.parse throws), so mixed versions
// degrade to "no frame", never to a crash.

export function packBinary(kind, bytes, meta) {
    const header = new TextEncoder().encode(JSON.stringify({ k: String(kind), m: meta ?? {} }))
    const frame = new Uint8Array(4 + header.length + bytes.byteLength)
    new DataView(frame.buffer).setUint32(0, header.length, true)
    frame.set(header, 4)
    frame.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), 4 + header.length)
    return frame
}

/** [kind, { ...meta, bytes: Uint8Array }] from a packed frame, or null if malformed. */
export function unpackBinary(buffer) {
    try {
        const view = new DataView(buffer)
        const headerLength = view.getUint32(0, true)
        const headerBytes = new Uint8Array(buffer, 4, headerLength)
        const header = JSON.parse(new TextDecoder().decode(headerBytes))
        const bytes = new Uint8Array(buffer.slice(4 + headerLength))
        return [header.k, { ...header.m, bytes }]
    } catch {
        return null
    }
}
