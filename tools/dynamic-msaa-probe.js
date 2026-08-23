/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// Instrument for the dynamic multisampling feature. It answers one question:
// what does scene.msaaSamples hold on each drawn frame, and what does
// DynamicMsaa believe about the camera at that moment?
//
// This instrument found the first fault in the feature: a comparison of the
// camera vectors on each drawn frame read the renormalization drift of
// CesiumJS as movement, so the sample count never came back. The camera
// columns below show that drift.
//
// It needs no tileset and no GPU. An empty scene still draws a frame when the
// camera moves, which is all the logic needs. SwiftShader gives a WebGL2
// context with multisampling, so it runs without a display:
//
//   node_modules/.bin/electron tools/dynamic-msaa-probe.js
//
// Output: tools/traces/dynamic-msaa-probe.json

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) { console.log("[probe]", ...a); }

app.commandLine.appendSwitch("headless");
app.commandLine.appendSwitch("use-gl", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

// Records one row per drawn frame: the sample count that the frame draws with
// and the private state of DynamicMsaa at that moment.
const PROBE_SOURCE = `window.__probe = (function () {
    const scene = window.tilesetViewer.viewer.scene;
    const rows = [];

    scene.postRender.addEventListener(function () {
        const d = window.tilesetViewer.dynamicMsaa;
        const c = scene.camera;
        rows.push({
            t: Math.round(performance.now()),
            samples: scene.msaaSamples,
            moving: d ? d._moving : null,
            enabled: d ? d._enabled : null,
            target: d ? d._targetSamples : null,
            transitions: d ? d._transitions : null,
            px: c.position.x,
        });
    });

    return {
        reset: function () { rows.length = 0; },
        read: function () { return rows.slice(); },
    };
})(); true`;

app.whenReady().then(async () => {
    const out = {};
    try {
        const win = new BrowserWindow({
            width: 1000, height: 700, show: false,
            webPreferences: {
                nodeIntegration: false, contextIsolation: true, sandbox: true,
                backgroundThrottling: false, preload: path.join(ROOT, "preload.js"),
            },
        });
        const wc = win.webContents;
        wc.on("console-message", (e) => log("[renderer]", e.message));

        await win.loadFile(path.join(ROOT, "web-page/index.html"));
        await wc.executeJavaScript(`new Promise(r=>{(function c(){window.tilesetViewer?r(true):setTimeout(c,50);})();})`);
        await sleep(1500);

        out.msaaSupported = await wc.executeJavaScript(`window.tilesetViewer.viewer.scene.msaaSupported`);
        out.maximumSamples = await wc.executeJavaScript(`window.tilesetViewer.viewer.scene.context._gl.getParameter(window.tilesetViewer.viewer.scene.context._gl.MAX_SAMPLES)`);
        out.dynamicMsaaExists = await wc.executeJavaScript(`!!window.tilesetViewer.dynamicMsaa`);
        log("msaaSupported", out.msaaSupported, "maxSamples", out.maximumSamples, "dynamicMsaa", out.dynamicMsaaExists);

        if (!out.dynamicMsaaExists) {
            log("no DynamicMsaa on the viewer - the context reports no multisampling support");
        }

        await wc.executeJavaScript(PROBE_SOURCE);

        // 1. Choose Full with the toggle on, camera at rest.
        await wc.executeJavaScript(`jQuery('#msaa-dynamic-checkbox').prop('checked', true).trigger('change');
            jQuery('#msaa-samples-select').val('4').trigger('change'); true`);
        await sleep(500);
        out.afterSelectFull = await wc.executeJavaScript(`(()=>{const d=window.tilesetViewer.dynamicMsaa;
            return {samples: window.tilesetViewer.viewer.scene.msaaSamples, moving: d._moving, enabled: d._enabled,
                target: d._targetSamples, transitions: d._transitions};})()`);
        log("after select Full (at rest)", JSON.stringify(out.afterSelectFull));

        // 2. Move the camera over several frames, the way a drag does.
        await wc.executeJavaScript(`window.__probe.reset(); true`);
        for (let i = 0; i < 20; ++i) {
            await wc.executeJavaScript(`window.tilesetViewer.viewer.camera.rotateRight(0.002); true`);
            await sleep(25);
        }
        out.duringMove = await wc.executeJavaScript(`window.__probe.read()`);
        log("frames during the move", out.duringMove.length,
            "samples seen", JSON.stringify(Array.from(new Set(out.duringMove.map(r => r.samples)))));

        // 3. Hold still and watch the restore.
        await sleep(1500);
        out.afterStop = await wc.executeJavaScript(`window.__probe.read()`);
        out.stateAfterStop = await wc.executeJavaScript(`(()=>{const d=window.tilesetViewer.dynamicMsaa;
            return {samples: window.tilesetViewer.viewer.scene.msaaSamples, moving: d._moving, enabled: d._enabled,
                target: d._targetSamples, transitions: d._transitions};})()`);
        log("state 1.5 s after the last move", JSON.stringify(out.stateAfterStop));
        log("last 6 frames", JSON.stringify(out.afterStop.slice(-6)));

        // 4. Turn the toggle off and look again.
        await wc.executeJavaScript(`jQuery('#msaa-dynamic-checkbox').prop('checked', false).trigger('change'); true`);
        await sleep(400);
        out.afterToggleOff = await wc.executeJavaScript(`window.tilesetViewer.viewer.scene.msaaSamples`);
        log("samples with the toggle off", out.afterToggleOff);

        if (!fs.existsSync(path.join(__dirname, "traces"))) fs.mkdirSync(path.join(__dirname, "traces"), {recursive: true});
        fs.writeFileSync(path.join(__dirname, "traces", "dynamic-msaa-probe.json"), JSON.stringify(out, null, 2));
        log("wrote tools/traces/dynamic-msaa-probe.json");
    } catch (e) {
        console.error("[probe] FAILED", e);
    } finally {
        await sleep(200);
        app.quit();
    }
});
