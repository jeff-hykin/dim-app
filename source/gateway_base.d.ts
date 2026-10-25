// Types for gateway_base.js
import type { AppZenoh } from "./zenoh.d.ts"

/** The gateway's event type for a shared-config change; the setting that moved is the next chunk, and the payload. */
export const CONFIG_EVENT: "config"

/** Desktop's base URL, ending in `/`: `origin`, or this page's own. Throws with no page URL and no `origin`. */
export function desktopBase(origin: string | undefined, who: string): string

/**
 * Subscribes to the gateway's config bust signal for `settings` (`null` or `[]`: every setting) and calls
 * `changed(setting)` for each one — and on a reconnect, with `null`. Never throws. Needs `"@zenoh-gateway"` in the
 * app's dimos.yaml `uses:`.
 */
export function watchConfig(
    settings: string[] | null,
    changed: (setting: string | null) => void,
    options?: { zenoh?: AppZenoh; onError?: (error: unknown) => void },
): () => void
