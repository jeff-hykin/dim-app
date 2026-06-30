// dim-app — binary/SDK compatibility check.
//
// THE POINT: an app pins a specific SDK version in its import URL
// (…/dim-app@<ver>/frontend.js). That SDK build only works with dim binaries in
// a known range — newer SDK features need a new enough `dim`. So the SDK, not
// the app author, declares which dim binaries it supports here. On connect the
// dashboard sends its binary version ({ __dimHost: { v } }); the SDK compares it
// to SUPPORTED_DIM and, if the host is too old/new, logs a clear error and shows
// a toast instead of failing in some confusing downstream way.
//
// This is automatic: app maintainers write nothing — they just pin an SDK
// version, and that pin carries the binary requirement with it.

/**
 * The range of `dim` binary versions THIS SDK build supports. Open-ended on the
 * top end on purpose: we declare the minimum the SDK needs and only add an upper
 * bound once a future binary is known to break us. Space-separated comparators
 * (e.g. ">=0.3.0 <1.0.0"); every comparator must hold.
 */
export const SUPPORTED_DIM = ">=0.3.0"

/** "v1.2.3" / "1.2.3-rc1+x" -> [1,2,3]; null if it isn't a semver. */
export function parseSemver(v) {
    if (typeof v !== "string") {
        return null
    }
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function cmp(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) {
            return a[i] < b[i] ? -1 : 1
        }
    }
    return 0
}

/**
 * Does `version` satisfy `range` (space-separated comparators)? An unparseable
 * `version` returns true — we can't judge a dev/unknown host, so we don't block.
 */
export function satisfiesRange(version, range) {
    const v = parseSemver(version)
    if (!v) {
        return true
    }
    for (const token of String(range).trim().split(/\s+/).filter(Boolean)) {
        const m = token.match(/^(>=|<=|>|<|=)?\s*(.+)$/)
        const target = parseSemver(m[2])
        if (!target) {
            continue
        }
        const c = cmp(v, target)
        const op = m[1] || "="
        const ok = op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0
        if (!ok) {
            return false
        }
    }
    return true
}

/**
 * Check the host (dim binary) version against SUPPORTED_DIM. On mismatch, logs an
 * error and best-effort toasts the user. Returns { ok, hostVersion, message }.
 * A null/unknown host version is treated as compatible (dev runs without a dim
 * binary don't set a version, so there's nothing to enforce).
 */
export function checkDimCompat({ app, hostVersion, ui, sdkVersion } = {}) {
    if (!parseSemver(hostVersion)) {
        return { ok: true, hostVersion: hostVersion ?? null }
    }
    if (satisfiesRange(hostVersion, SUPPORTED_DIM)) {
        return { ok: true, hostVersion }
    }
    const message =
        `[dim:${app}] this app's dim-app SDK (v${sdkVersion}) needs a dim binary ${SUPPORTED_DIM}, ` +
        `but this desktop is dim v${hostVersion}. Update dim (or install an app build that targets this binary).`
    console.error(message)
    try {
        ui?.toast?.(message)
    } catch { /* an out-of-range host may not even have the /ui bridge — log is enough */ }
    return { ok: false, hostVersion, message }
}
