// Types for shell.js
export type ShellCommandRequest = {
    run: string
    note?: string
    needsStdout?: boolean
    cwd?: string
    env?: Record<string, string>
}
export type ShellCommandResult = {
    run: string
    note: string
    needsStdout: boolean
    status: "pending" | "running" | "done" | "failed" | "skipped"
    exitCode: number | null
    output: string
    stdout: string | null
    stderr: string | null
    attempts: number
    resolvedBy: "user" | "agent" | null
}
export type ShellSession = {
    id?: string
    status: "pending" | "running" | "blocked" | "succeeded" | "failed" | "cancelled" | "unavailable"
    reason?: string | null
    commands: ShellCommandResult[]
}
export type ShellOptions = { origin?: string; onUpdate?: (session: ShellSession) => void; signal?: AbortSignal }
export function runShell(
    request: { title: string; message?: string; app?: string; timeout?: number; commands: ShellCommandRequest[] },
    options?: ShellOptions,
): Promise<ShellSession>
export function runCommand(
    run: string,
    details: { title: string; note?: string; message?: string; needsStdout?: boolean; app?: string; timeout?: number },
    options?: ShellOptions,
): Promise<Partial<Omit<ShellCommandResult, "status">> & { status: ShellSession["status"]; reason?: string | null }>
