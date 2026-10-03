// dim-app — the built-in popups (browser only): toasts, confirm/ask dialogs and the sudo password prompt.
//
// The frontend renders these itself — for its own dimApp.ui.* calls, and for the backend's, which arrive over the
// app's websocket. A popup is a plain DOM overlay with inline styles (it picks up the page's dimOS theme tokens
// variables when it has them), so it needs nothing from the host page.

const open = new Map() // id -> close(result)

function el(tag, style, text) {
    const node = document.createElement(tag)
    node.style.cssText = style
    if (text != null) {
        node.textContent = text
    }
    return node
}

const FONT = "font:13px/1.45 var(--sans,system-ui,-apple-system,sans-serif);"
const BUTTON = FONT +
    "padding:6px 14px;border-radius:var(--radius,6px);border:1px solid var(--border,rgba(127,127,127,.4));cursor:pointer;"

function toast(message, kind) {
    let stack = document.getElementById("dim-app-toasts")
    if (!stack) {
        stack = el(
            "div",
            "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:min(520px,90vw);pointer-events:none",
        )
        stack.id = "dim-app-toasts"
        document.body.append(stack)
    }
    // the theme's .dim-toast look: a card-colored pill, the border tinted by kind
    const edges = { ok: "var(--ok,#2e7d32)", warn: "var(--warn,#b26a00)", error: "var(--danger,#c62828)" }
    const item = el(
        "div",
        FONT +
            "font-size:12.5px;padding:8px 16px;border-radius:999px;background:var(--card,#1e1e1e);color:var(--fg,#eee);" +
            `border:1px solid ${edges[kind] ?? "var(--border,rgba(127,127,127,.4))"};` +
            "box-shadow:var(--shadow-lg,0 4px 16px rgba(0,0,0,.3))",
        message,
    )
    stack.append(item)
    setTimeout(() => item.remove(), 5000)
    return true
}

/** How each method looks, and what OK / Cancel answer. */
function describe(method, args) {
    const yesNo = method === "askBoolean"
    if (method === "confirm" || yesNo) {
        return {
            title: args.title || (yesNo ? "Question" : "Confirm"),
            okText: args.okText || (yesNo ? "Yes" : "OK"),
            cancelText: args.cancelText || (yesNo ? "No" : "Cancel"),
            answer: (confirmed) => confirmed,
        }
    }
    if (method === "ask") {
        return {
            title: args.title ?? "",
            input: {
                value: args.default ?? "",
                placeholder: args.placeholder ?? "",
                type: args.password ? "password" : "text",
            },
            okText: args.okText || "OK",
            cancelText: args.cancelText || "Cancel",
            answer: (confirmed, value) => confirmed ? value : null,
        }
    }
    if (method === "password") {
        const command = Array.isArray(args.command) ? args.command.join(" ") : (args.command ?? "")
        return {
            title: args.title || "Administrator privileges required",
            message: args.reason
                ? `${args.reason} Enter your password to approve, or Cancel to deny.`
                : "This app wants to run this command as administrator. Enter your password to approve, or Cancel to deny:",
            command: command ? `sudo ${command}` : "",
            input: { value: "", placeholder: "password", type: "password" },
            okText: "Run",
            cancelText: "Cancel",
            danger: true,
            answer: (confirmed, value) => confirmed ? value : null,
        }
    }
    return null
}

/**
 * Shows a popup and resolves with its answer: toast → true, confirm/askBoolean → boolean, ask → string or null,
 * password → string or null. `id` lets cancel(id) take it down without an answer.
 */
export function showUi(method, args = {}, id = null) {
    if (method === "toast") {
        return Promise.resolve(toast(String(args.message ?? ""), args.kind))
    }
    const look = describe(method, args)
    if (!look) {
        return Promise.reject(new Error(`unknown ui method: ${method}`))
    }
    return new Promise((resolve) => {
        const overlay = el(
            "div",
            "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)",
        )
        const box = el(
            "div",
            FONT +
                "min-width:320px;max-width:520px;padding:18px;border-radius:var(--radius-lg,8px);display:flex;flex-direction:column;gap:10px;" +
                "background:var(--card,var(--bg,#1e1e1e));color:var(--fg,#eee);border:1px solid var(--border,transparent);" +
                "box-shadow:var(--shadow-lg,0 12px 40px rgba(0,0,0,.5))",
        )
        box.setAttribute("role", "dialog")
        box.dataset.dimAppUi = method
        if (look.title) {
            box.append(el("div", "font-weight:600;font-size:15px", look.title))
        }
        const message = look.message ?? args.message
        if (message) {
            box.append(el("div", "white-space:pre-wrap", message))
        }
        if (look.command) {
            box.append(
                el(
                    "pre",
                    "margin:0;padding:8px;border-radius:var(--radius,6px);background:var(--muted,rgba(127,127,127,.15));font-family:var(--mono,monospace);white-space:pre-wrap",
                    look.command,
                ),
            )
        }
        let input = null
        if (look.input) {
            input = el(
                "input",
                FONT +
                    "padding:6px 8px;border-radius:var(--radius,6px);border:1px solid var(--input,rgba(127,127,127,.5));background:transparent;color:inherit",
            )
            Object.assign(input, look.input, { autocomplete: "off" })
            box.append(input)
        }
        const actions = el("div", "display:flex;justify-content:flex-end;gap:8px;margin-top:4px")
        const cancel = el("button", BUTTON + "background:transparent;color:inherit", look.cancelText)
        const ok = el(
            "button",
            BUTTON +
                (look.danger
                    ? "border:0;color:var(--danger-fg,#fff);background:var(--danger,#c62828)"
                    : "border:0;color:var(--primary-fg,#fff);background:var(--primary,#2f6fed)"),
            look.okText,
        )
        actions.append(cancel, ok)
        box.append(actions)
        overlay.append(box)
        const close = (result) => {
            open.delete(id)
            overlay.remove()
            resolve(result)
        }
        const settle = (confirmed) => close(look.answer(confirmed, input?.value ?? ""))
        if (id != null) {
            open.set(id, close)
        }
        cancel.onclick = () => settle(false)
        ok.onclick = () => settle(true)
        overlay.onkeydown = (event) => {
            if (event.key === "Escape") {
                settle(false)
            } else if (event.key === "Enter" && input) {
                settle(true)
            }
        }
        document.body.append(overlay)
        setTimeout(() => (input ?? ok).focus(), 30)
    })
}

/** Takes down popup `id` (another frontend answered it, or the asker went away); it resolves null. */
export function cancelUi(id) {
    open.get(id)?.(null)
}
