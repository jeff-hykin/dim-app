// Types for events.js
import type { AppZenoh } from "./zenoh.d.ts"
export const EVENTS_TOPIC: "events"
export function appEvents(
    onEvent: (event: any) => void,
    options?: { topic?: string; onOpen?: () => void; onClose?: (info: { wasOpen: boolean }) => void; zenoh?: AppZenoh },
): () => void
