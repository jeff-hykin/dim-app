// Types for recordings.js
/**
 * The folder recordings are written to and read from (`GET /gateways/dimos/history/recordings`). Needs
 * `GET /history/recordings` under `"@dimos-gateway"` in the app's dimos.yaml `uses:`, or Desktop answers 403.
 */
export function recordingsDir(options?: { origin?: string; fresh?: boolean; fetch?: typeof fetch }): Promise<string>
