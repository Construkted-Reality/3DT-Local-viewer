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
        // Cesium stores each RGB coefficient in two packed half-float words.
        const packedHarmonics = primitive?._shData || [];
        const half = value => {
            const sign = value & 0x8000 ? -1 : 1;
            const exponent = (value >>> 10) & 31;
            const fraction = value & 1023;
            if (exponent === 31) return fraction ? NaN : sign * Infinity;
            return sign * (exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction * 2 ** -24);
        };
        const harmonics = [];
        for (let i = 0; i < packedHarmonics.length; i += 2) {
            harmonics.push(half(packedHarmonics[i] & 0xffff), half(packedHarmonics[i] >>> 16), half(packedHarmonics[i + 1] & 0xffff));
        }
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
            shDegree: primitive?._sphericalHarmonicsDegree || 0,
            shValues: harmonics.length,
            shPackedWords: packedHarmonics.length,
            shNonzero: harmonics.reduce((count, value) => count + (value !== 0 ? 1 : 0), 0),
            shFinite: harmonics.every(Number.isFinite),
            shPrefix: Array.from(harmonics.slice(0, 3)),
            pivot, measurement,
            requestRenderMode: scene.requestRenderMode,
            unlimitedIdleTime: scene.maximumRenderTimeChange === Infinity,
            dynamicMsaaPresent: !!application.dynamicMsaa,
            defaultRenderLoop: application.viewer.useDefaultRenderLoop,
            pixelPhase: window.__splatPixelPhase,
            renderErrors: window.__splatRenderErrors || [],
            camera: scene.camera.positionWC,
            sphere: tileset.boundingSphere,
            selected: tileset._selectedTiles.length,
            loaded: tileset.statistics.numberOfTilesWithContentReady,
            pending: tileset.statistics.numberOfPendingRequests,
            children: tileset.root.children.map(tile => ({state: tile._contentState, visible: tile._visible, sphere: tile.boundingSphere}))
        };
    })()`), "scene inspection");
}

async function visiblePixels(window) {
    return bounded(window.webContents.executeJavaScript(`(async () => {
        const application = window.tilesetViewer;
        const scene = application.viewer.scene;
        const tileset = application._leftTileset;
        const gl = scene.canvas.getContext("webgl2");
        const read = () => new Promise(resolve => {
            const remove = scene.postRender.addEventListener(() => {
                const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
                gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                remove();
                resolve(pixels);
            });
            // Request the next frame after the current postRender callback completes.
            setTimeout(() => scene.requestRender(), 0);
        });
        window.__splatPixelPhase = "shown";
        const shown = await read();
        const original = tileset.show;
        try {
            tileset.show = false;
            window.__splatPixelPhase = "hidden";
            const hidden = await read();
            let changed = 0;
            for (let i = 0; i < shown.length; i += 4) {
                if (Math.max(Math.abs(shown[i] - hidden[i]), Math.abs(shown[i + 1] - hidden[i + 1]),
                    Math.abs(shown[i + 2] - hidden[i + 2])) > 2) changed++;
            }
            return changed;
        } finally {
            tileset.show = original;
            window.__splatPixelPhase = "restore";
            await read();
        }
    })()`), "rendered splat visibility");
}

app.whenReady().then(async () => {
    const result = {cases: [], errors: [], diagnosticFrameRequests: !!process.env.SPLAT_REQUEST_FRAMES};
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
                    if (event.level === 3 || event.level === "error") record.errors.push(event.message);
                });
                window.webContents.on("render-process-gone", (_, details) => record.errors.push(`Renderer exited: ${details.reason}`));
                await bounded(window.loadFile(path.join(__dirname, "..", "web-page", "index.html")), "viewer load");
                await window.webContents.executeJavaScript(`window.__splatRenderErrors = []; window.tilesetViewer.viewer.scene.renderError.addEventListener((scene, error) => window.__splatRenderErrors.push(String(error.stack || error))); true`);
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
                    if (process.env.SPLAT_REQUEST_FRAMES) await window.webContents.executeJavaScript("window.tilesetViewer.viewer.scene.requestRender()");
                    record.observed = await inspect(window);
                    if (record.observed.tilesLoaded && record.observed.splats === fixture.expectedSplats) break;
                } while (Date.now() < deadline);
                await window.webContents.executeJavaScript("window.tilesetViewer.viewer.scene.requestRender()");
                await sleep(500);
                record.observed = await inspect(window);
                if (record.observed.defaultRenderLoop) record.observed.visiblePixels = await visiblePixels(window);
                const capture = await window.webContents.capturePage();
                fs.writeFileSync(path.join(destination, `${path.basename(fixture.name)}.png`), capture.toPNG());
                const expectedShValues = fixture.expectedSHDegree === undefined ? undefined :
                    fixture.expectedSplats * ((fixture.expectedSHDegree + 1) ** 2 - 1) * 3;
                const harmonicsPass = fixture.expectedSHDegree === undefined ||
                    (record.observed.shDegree === fixture.expectedSHDegree && record.observed.shValues === expectedShValues &&
                    record.observed.shFinite && (fixture.expectedSHDegree === 0 ||
                    (record.observed.shNonzero > 0 && record.observed.shPrefix.length === 3 &&
                    record.observed.shPrefix.every(value => Math.abs(value - fixture.expectedSHValue) <= 0.05))));
                record.pass = record.observed.version === "1.142.0" && record.observed.splats === fixture.expectedSplats &&
                    record.observed.visiblePixels > 0 && record.observed.pivot && record.observed.measurement && record.observed.requestRenderMode &&
                    record.observed.unlimitedIdleTime && record.observed.dynamicMsaaPresent &&
                    record.observed.defaultRenderLoop && harmonicsPass && record.observed.renderErrors.length === 0 && record.errors.length === 0;
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
