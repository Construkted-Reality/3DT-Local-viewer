// Reads the version of the running app from the main process.
//
// The renderer must NOT bundle a copy of package.json for this. app.js is not
// rebuilt on launch (see CLAUDE.md), so a bundled copy survives a version bump
// and names the wrong version. app.getVersion() in the main process always
// reports the version that the user really runs.
//
// Returns "unknown" outside Electron, for example under the browser-sync dev
// server, where window.api does not exist.
async function getAppVersion() {
    if (!window.api || typeof window.api.getAppVersion !== "function")
        return "unknown";

    try {
        return await window.api.getAppVersion();
    } catch (error) {
        console.error("failed to read the app version", error);
        return "unknown";
    }
}

export {getAppVersion}
