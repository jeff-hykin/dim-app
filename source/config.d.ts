// Types for config.js
import type { AppZenoh } from "./zenoh.d.ts"

/** The shared `$DIMOS_HOME/config.yaml` as the dimos gateway resolves it, exactly as `GET /gateways/dimos/config` sends it. */
export type SharedConfig = { path: string; recordingsDir: string }

/** The gateway's event type for "the shared config changed" (`<ns>/dimos/events/config`); it carries no values. */
export const CONFIG_EVENT: "config"

/**
 * The shared dimos config (`GET /gateways/dimos/config`), asked once and kept; a `config` event (while something is
 * watching) makes the next call ask again. Needs `GET /config` under `"@dimos-gateway"` in the app's dimos.yaml
 * `uses:`, or Desktop answers 403. Throws when there's no answer yet and the gateway can't be reached or refuses; once
 * there is one, a failed re-ask leaves it standing, stale. `{ fresh: true }` asks again and throws on failure.
 */
export function sharedConfig(
    options?: { origin?: string; fresh?: boolean; fetch?: typeof fetch },
): Promise<SharedConfig>

/**
 * Subscribes to the gateway's `config` event so the config stays current. With `callback`: called with the config now
 * and after every change. With none: the subscription only busts `sharedConfig()`'s cache. Never throws. Needs
 * `GET /config` under `"@dimos-gateway"` **and** `"@zenoh-gateway"` in the app's dimos.yaml `uses:`.
 */
export function watchSharedConfig(
    callback?: ((config: SharedConfig) => void) | null,
    options?: { origin?: string; fetch?: typeof fetch; zenoh?: AppZenoh; onError?: (error: unknown) => void },
): () => void
