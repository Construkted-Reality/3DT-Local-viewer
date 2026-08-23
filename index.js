const {app, BrowserWindow, ipcMain, dialog} = require('electron');
const path = require('path');
const {startServer, stopServer} = require('./server');
const {menu} = require("./menu");

const isWindows = process.platform === "win32";

let mainWindow;

const openDevTool = false;

// The settings panel measures GPU frame time with the WebGL2 extension
// EXT_disjoint_timer_query_webgl2. Chromium hides that extension behind the
// draft-extension switch, so the renderer cannot get it without this line.
// The app displays only its own bundled local page, so the wider extension set
// reaches no third-party content. Cesium itself does not use draft extensions.
app.commandLine.appendSwitch('enable-webgl-draft-extensions');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js')
        },
        frame: false
    });

    mainWindow.loadFile('./web-page/index.html');

    // The app only ever displays its own bundled local page; block any attempt
    // to navigate this privileged window elsewhere or spawn child windows.
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url !== mainWindow.webContents.getURL()) {
            event.preventDefault();
        }
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));

    mainWindow.webContents.on('console-message', (event) => {
        const levels = ['LOG', 'WARN', 'ERROR'];
        const tag = levels[event.level] || event.level;
        console.log(`[renderer ${tag}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });

    if (openDevTool)
        mainWindow.webContents.openDevTools({mode: 'detach'});
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

ipcMain.on('display-app-menu', (e, args) => {
    if (isWindows && mainWindow) {
        menu.popup({
            window: mainWindow,
            x: args.x,
            y: args.y
        });
    }
});

ipcMain.on('window-minimize', () => {
    if (mainWindow && mainWindow.isMinimizable()) mainWindow.minimize();
});

ipcMain.on('window-max-unmax', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});

ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
});

// The settings panel shows this value. app.getVersion() reads the version of
// the running app, so a stale renderer bundle cannot report an old version.
ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('window-is-maximized', () => {
    return mainWindow ? mainWindow.isMaximized() : false;
});

async function loadTilesetForSlot(slot) {
    if (!mainWindow) return;

    const tilesetPath = dialog.showOpenDialogSync(mainWindow, {
        title: `Select tileset JSON for the ${slot} side`,
        properties: ['openFile'],
    });

    if (!tilesetPath || tilesetPath.length === 0) return;

    const dir = path.dirname(tilesetPath[0]);
    const baseName = path.basename(tilesetPath[0]);
    const port = slot === 'right' ? 3001 : 3000;
    const method = slot === 'right' ? 'addRightTileset' : 'addTileset';

    stopServer(slot);

    // Wait until the socket is actually listening before telling the renderer
    // to fetch from it; a bind failure rejects here instead of killing the app.
    try {
        await startServer(slot, port, dir);
    } catch (err) {
        if (!mainWindow) return;
        dialog.showMessageBoxSync(mainWindow, {
            type: "error",
            title: "Error",
            message: "Could not start the tileset server.",
            detail: err && err.message ? err.message : String(err)
        });
        return;
    }

    if (!mainWindow) return;

    const tilesetUrl = `http://localhost:${port}/${baseName}`;
    const folderName = path.basename(dir);
    mainWindow.webContents.executeJavaScript(
        `window.tilesetViewer.${method}(${JSON.stringify(tilesetUrl)}, ${JSON.stringify(folderName)})`
    );
}

ipcMain.on('select-3d-tile-folder', () => loadTilesetForSlot('left'));
ipcMain.on('select-3d-tile-folder-right', () => loadTilesetForSlot('right'));

ipcMain.on('tileset-load-error', () => {
    dialog.showMessageBoxSync({
        type: "error",
        title: "Error",
        message: "failed to load tileset!"
    });
});
