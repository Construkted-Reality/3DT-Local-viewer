const {remote} = require("electron");
/**
 *
 * note that following does not work
 * const { dialog } = require("electron").remote.dialog;
 */
const dialog = remote.dialog;

const {
    getCurrentWindow,
    openMenu,
    minimizeWindow,
    maximizeWindow,
    unmaximizeWindow,
    maxUnmaxWindow,
    isWindowMaximized,
    closeWindow
} = require("./menu-functions");

const origError = console.error;
console.error = function(...args) {
    const formatted = args.map(a => {
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack}`;
        if (typeof a === 'object' && a !== null) {
            try { return JSON.stringify(a, Object.getOwnPropertyNames(a)); }
            catch { return String(a); }
        }
        return String(a);
    });
    origError.apply(console, formatted);
};

window.addEventListener("DOMContentLoaded", () => {
    window.getCurrentWindow = getCurrentWindow;
    window.openMenu = openMenu;
    window.minimizeWindow = minimizeWindow;
    window.maximizeWindow = maximizeWindow;
    window.unmaximizeWindow = unmaximizeWindow;
    window.maxUnmaxWindow = maxUnmaxWindow;
    window.isWindowMaximized = isWindowMaximized;
    window.closeWindow = closeWindow;


});