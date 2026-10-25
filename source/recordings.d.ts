// Types for recordings.js
import type { AppZenoh } from "./zenoh.d.ts"

/**
 * The folder recordings are written to and read from (`GET /gateways/dimos/history/recordings`). Needs
 * `GET /history/recordings` under `"@dimos-gateway"` in the app's dimos.yaml `uses:`, or Desktop answers 403.
 */
export function recordingsDir(options?: { origin?: string; fresh?: boolean; fetch?: typeof fetch }): Promise<string>

/**
 * Keeps that answer current: `callback` is called with the folder now and again every time it moves, off the gateway's
 * config event for this one setting. `eager: false` calls back with `null` instead and leaves the re-ask to the next
 * `recordingsDir()`. Never throws. Needs `GET /history/recordings` under `"@dimos-gateway"` **and**
 * `"@zenoh-gateway"` in the app's dimos.yaml `uses:`.
 */
export function watchRecordingsDir(
    callback?: ((dir: string | null) => void) | null,
    options?: {
        origin?: string
        fetch?: typeof fetch
        zenoh?: AppZenoh
        eager?: boolean
        onError?: (error: unknown) => void
    },
): () => void
