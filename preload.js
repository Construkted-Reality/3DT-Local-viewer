const { contextBridge, ipcRenderer } = require("electron");

// Forward console.error with deep-stringified Errors so they survive
// the main-process console-message bridge as readable text.
const origError = console.error;
console.error = function (...args) {
    const formatted = args.map(a => {
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack}`;
        if (typeof a === "object" && a !== null) {
            try { return JSON.stringify(a, Object.getOwnPropertyNames(a)); }
            catch { return String(a); }
        }
        return String(a);
    });
    origError.apply(console, formatted);
};

contextBridge.exposeInMainWorld("api", {
    openMenu: (x, y) => ipcRenderer.send("display-app-menu", { x, y }),
    minimizeWindow: () => ipcRenderer.send("window-minimize"),
    maxUnmaxWindow: () => ipcRenderer.send("window-max-unmax"),
    closeWindow: () => ipcRenderer.send("window-close"),
    isWindowMaximized: () => ipcRenderer.invoke("window-is-maximized"),
    selectTileset: () => ipcRenderer.send("select-3d-tile-folder"),
    notifyTilesetLoadError: () => ipcRenderer.send("tileset-load-error"),
});
