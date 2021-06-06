const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('path');
const fs = require('fs');
const {startServer, stopServer} = require('./server');
const {menu} = require("./menu");
const {dialog} = require('electron');
const isWindows = process.platform === "win32";

let mainWindow;

const openDevTool = true;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            enableRemoteModule: true,
            nodeIntegration: true,
            contextIsolation: false,
            preload: path.join(__dirname, 'preload.js')
        },
        frame: false //Remove frame to hide default menu
    });

    mainWindow.loadFile('./web-page/index.html');

    if(openDevTool)
        mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
});

ipcMain.on(`display-app-menu`, function (e, args) {
    if (isWindows && mainWindow) {
        menu.popup({
            window: mainWindow,
            x: args.x,
            y: args.y
        });
    }
});

ipcMain.on(`select-3d-tile-folder`, (e, args) => {
    if (isWindows && mainWindow) {
        const options = {
            title: 'Select a tileset json file',
            properties: ['openFile'],
        };

        const tilesetPath = dialog.showOpenDialogSync(mainWindow, options);

        if(!tilesetPath)
            return;

        const dir = path.dirname(tilesetPath[0]);
        const baseName = path.basename(tilesetPath[0]);

        const port = 3000;

        stopServer();
        startServer(port, dir);

        const tilesetUrl = `http://localhost:${port}/${baseName}`;

        mainWindow.webContents.executeJavaScript(`window.tilesetViewer.addTileset("${tilesetUrl}")`);
    }
});

ipcMain.on('tileset-load-error', () => {
    const messageBoxOptions = {
        type: "error",
        title: "Error",
        message: "failed to load tileset!"
    };

    dialog.showMessageBoxSync(messageBoxOptions);
});

