const {app, BrowserWindow, ipcMain, dialog} = require('electron');
const path = require('path');
const {startServer, stopServer} = require('./server');
const {menu} = require("./menu");

const isWindows = process.platform === "win32";

let mainWindow;

const openDevTool = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js')
        },
        frame: false
    });

    mainWindow.loadFile('./web-page/index.html');

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

ipcMain.handle('window-is-maximized', () => {
    return mainWindow ? mainWindow.isMaximized() : false;
});

function loadTilesetForSlot(slot) {
    if (!mainWindow) return;

    const tilesetPath = dialog.showOpenDialogSync(mainWindow, {
        title: `Select tileset JSON for the ${slot} side`,
        properties: ['openFile'],
    });

    if (!tilesetPath) return;

    const dir = path.dirname(tilesetPath[0]);
    const baseName = path.basename(tilesetPath[0]);
    const port = slot === 'right' ? 3001 : 3000;
    const method = slot === 'right' ? 'addRightTileset' : 'addTileset';

    stopServer(slot);
    startServer(slot, port, dir);

    const tilesetUrl = `http://localhost:${port}/${baseName}`;
    const displayPath = tilesetPath[0];
    mainWindow.webContents.executeJavaScript(
        `window.tilesetViewer.${method}(${JSON.stringify(tilesetUrl)}, ${JSON.stringify(displayPath)})`
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
