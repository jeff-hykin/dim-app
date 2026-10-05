// Types for react.js
import type { BackendStateOptions } from "./backend_state.d.ts"
export function useBackendState<T = any>(
    source: string | null | undefined,
    options?: BackendStateOptions & { initial?: T },
): [T | undefined, { loading: boolean; error: Error | null; version: number | null; refresh: () => Promise<void> }]
