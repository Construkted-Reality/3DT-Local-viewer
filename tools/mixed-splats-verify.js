/*eslint-env node*/
"use strict";

// Run with Electron on the test server under xvfb-run.
// SPLAT_CASES is a JSON array of {name, directory, expectedSplats}.
// The real renderer bundle and embedded Cesium distribution must be built first.
const {app, BrowserWindow, ipcMain} = require("electron");
const fs = require("fs");
const path = require("path");
const {startServer, stopServer} = require("../server");

const destination = process.env.SPLAT_RESULTS;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (destination) app.setPath("userData", path.join(destination, "electron-profile"));
async function bounded(operation, label, milliseconds = 10000) {
    let timer;
    try {
        return await Promise.race([operation, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timeout`)), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
ipcMain.handle("app-version", () => app.getVersion());
ipcMain.handle("window-is-maximized", () => false);
// Keep Electron alive while the matrix replaces its last window between cases.
app.on("window-all-closed", () => {});

async function inspect(window) {
    return bounded(window.webContents.executeJavaScript(`(() => {
        const application = window.tilesetViewer;
        const scene = application.viewer.scene;
        const tileset = application._leftTileset;
        const primitive = tileset && tileset.gaussianSplatPrimitive;
        const snap = application._rotationCenterSnap;
        const source = snap._splatSource;
        source._ensureFresh();
        let pivot = false, measurement = false;
        const centers = source._centers;
        for (let i = 0; i < centers.length && !measurement; i += 3) {
            const world = new Cesium.Cartesian3(centers[i], centers[i + 1], centers[i + 2]);
            const pixel = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
            if (!pixel || pixel.x < 0 || pixel.y < 0 || pixel.x >= scene.canvas.clientWidth || pixel.y >= scene.canvas.clientHeight) continue;
            pivot = pivot || !!snap._resolve(pixel);
            const result = snap.resolveMeasurement(pixel);
            measurement = !!result && result.source === "splat" && Number.isFinite(result.point.x);
        }
        return {
            version: Cesium.VERSION,
            tilesLoaded: !!tileset && tileset.tilesLoaded,
            splats: primitive ? primitive._numSplats : 0,
            centers: centers.length / 3,
            pivot, measurement,
            requestRenderMode: scene.requestRenderMode,
            unlimitedIdleTime: scene.maximumRenderTimeChange === Infinity,
            dynamicMsaaPresent: !!application.dynamicMsaa
        };
    })()`), "scene inspection");
}

app.whenReady().then(async () => {
    const result = {cases: [], errors: []};
    let window;
    try {
        if (!destination || !process.env.SPLAT_CASES) throw new Error("Set SPLAT_RESULTS and SPLAT_CASES");
        fs.mkdirSync(destination, {recursive: true});
        const cases = JSON.parse(fs.readFileSync(process.env.SPLAT_CASES, "utf8"));
        for (const fixture of cases) {
            console.log(`Starting ${fixture.name}`);
            const record = {name: fixture.name, errors: []};
            result.cases.push(record);
            try {
                const server = await startServer("probe", 0, fixture.directory);
                window = new BrowserWindow({width: 1024, height: 768, show: true, webPreferences: {
                    nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
                    preload: path.join(__dirname, "..", "preload.js")
                }});
                window.webContents.on("console-message", event => {
                    if (event.level === 3) record.errors.push(event.message);
                });
                window.webContents.on("render-process-gone", (_, details) => record.errors.push(`Renderer exited: ${details.reason}`));
                await bounded(window.loadFile(path.join(__dirname, "..", "web-page", "index.html")), "viewer load");
                let loadTimer;
                try {
                    await Promise.race([
                        window.webContents.executeJavaScript(`window.tilesetViewer._loadTilesetIntoSlot(${JSON.stringify(`http://localhost:${server.address().port}/tileset.json`)}, "left", "probe").then(() => true)`),
                        new Promise((_, reject) => { loadTimer = setTimeout(() => reject(new Error("Initial tileset load timeout")), 15000); })
                    ]);
                } finally { clearTimeout(loadTimer); }
                const deadline = Date.now() + 15000;
                do {
                    await sleep(200);
                    record.observed = await inspect(window);
                    if (record.observed.tilesLoaded && record.observed.splats === fixture.expectedSplats) break;
                } while (Date.now() < deadline);
                await window.webContents.executeJavaScript("window.tilesetViewer.viewer.scene.requestRender()");
                await sleep(500);
                record.observed = await inspect(window);
                const capture = await window.webContents.capturePage();
                fs.writeFileSync(path.join(destination, `${path.basename(fixture.name)}.png`), capture.toPNG());
                record.pass = record.observed.version === "1.142.0" && record.observed.splats === fixture.expectedSplats &&
                    record.observed.pivot && record.observed.measurement && record.observed.requestRenderMode &&
                    record.observed.unlimitedIdleTime && record.observed.dynamicMsaaPresent && record.errors.length === 0;
            } catch (error) {
                record.errors.push(String(error.stack || error));
                if (window && !window.isDestroyed()) {
                    try { record.observed = await inspect(window); } catch (inspectionError) { record.errors.push(String(inspectionError)); }
                }
                record.pass = false;
            } finally {
                if (window && !window.isDestroyed()) window.destroy();
                window = undefined;
                stopServer("probe");
            }
        }
    } catch (error) {
        result.errors.push(String(error.stack || error));
    } finally {
        result.pass = result.cases.length > 0 && result.cases.every(item => item.pass) && result.errors.length === 0;
        if (destination) fs.writeFileSync(path.join(destination, "results.json"), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        app.exit(result.pass ? 0 : 1);
    }
});
