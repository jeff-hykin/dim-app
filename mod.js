// dim-app's one entry: the public API of everything in source/. A file on its own is fine too
// (`./dim-app/source/zenoh.js`). Not here: source/react.js (imports "react"; import it directly) and source/serve.js
// (the app server program).
//
//     import { DimApp, initTheme } from "./dim-app/mod.js"

export { DimApp, dimosKey } from "./source/dim_app.js"
export { appBase, checkTopic, getZenoh } from "./source/zenoh.js"
export { rosCodec, rosTypeName, rosTypeOfSample } from "./source/ros.js"
export { readDimosApp } from "./source/app_env.js"
export { DimAppBackend, dimContext } from "./source/backend.js"
export { DimAppFrontend, VERSION } from "./source/frontend.js"
export { resolveSource, watchBackendState } from "./source/backend_state.js"
export {
    appInstalled,
    BUILTIN_APPS,
    emptyState,
    findApp,
    inDesktopShell,
    listApps,
    openApp,
    underDesktop,
} from "./source/desktop.js"
export { onDesktopEvent, onDesktopReconnect, onDimosEvent } from "./source/desktop_events.js"
export { captureErrors, reportError } from "./source/errors.js"
export { appEvents, EVENTS_TOPIC } from "./source/events.js"
export { publishFrontend, stateChanged } from "./source/frontend_publish.js"
export { lowLevelAlert, notify } from "./source/notify.js"
export { runCommand, runShell } from "./source/shell.js"
export {
    corners,
    desktopSkin,
    initInsets,
    initTheme,
    insets,
    isDark,
    onDesktop,
    onThemeChange,
    THEME_FONTS,
    themeColors,
    themeFontsReady,
    themeName,
} from "./source/theme.js"
