/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// Verification for the performance readout in the settings panel, against the
// REAL app bundle. Launches the renderer, opens the settings panel, then checks:
//   A. all three value elements exist and start at "idle".
//   B. a stream of rendered frames gives a frame rate, a CPU frame time and,
//      when the driver allows the timer query, a GPU frame time.
//   C. an idle scene returns the values to "idle".
//   D. the panel shows the version of the running app, which the renderer reads
//      from the main process over IPC.
//
// The GPU value needs the WebGL2 extension EXT_disjoint_timer_query_webgl2.
// The script reports whether this Electron build and this driver give it.
//
// Run:  DISPLAY=:0 node_modules/.bin/electron tools/perf-readout-verify.js

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");
const {startServer} = require("../server");

const ROOT = path.join(__dirname, "..");
const LEFT_DIR = path.join(ROOT, "postfix-hp");
const SETTLE_MS = 3000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) { console.log("[perf-readout]", ...a); }

// Same switch as index.js: Chromium hides the timer-query extension without it.
app.commandLine.appendSwitch("enable-webgl-draft-extensions");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(async () => {
    const results = {};
    try {
        // The readout is scene-level, so a tileset is optional. Load the sample
        // when it is present, because a real scene gives a realistic frame time.
        const haveSample = fs.existsSync(path.join(LEFT_DIR, "tileset.json"));

        if (haveSample)
            await startServer("left", 3000, LEFT_DIR);
        else
            log("no sample tileset at", LEFT_DIR, "- running against an empty scene");

        const win = new BrowserWindow({
            width: 1280, height: 800, show: true,
            webPreferences: {
                nodeIntegration: false, contextIsolation: true, sandbox: true,
                backgroundThrottling: false, preload: path.join(ROOT, "preload.js"),
            },
        });
        const wc = win.webContents;
        wc.on("console-message", (e) => log("[renderer]", e.message));

        await win.loadFile(path.join(ROOT, "web-page/index.html"));
        await wc.executeJavaScript(`new Promise(r=>{(function c(){window.tilesetViewer?r(true):setTimeout(c,50);})();})`);

        if (haveSample) {
            await wc.executeJavaScript(`window.tilesetViewer.addTileset("http://localhost:3000/tileset.json","postfix-hp")`);
            await wc.executeJavaScript(`new Promise((resolve)=>{const v=window.tilesetViewer;
                if(v&&v._leftTileset)return resolve(true);v.tilesetLoaded.addEventListener(()=>resolve(true));})`);
        }

        await sleep(SETTLE_MS);

        // Open the settings panel. The readout writes to the DOM only when the
        // panel is visible.
        await wc.executeJavaScript(`jQuery('#construkted-popup-settings-btn').trigger('click'); true`);
        await sleep(1500);

        const readValues = () => wc.executeJavaScript(`(()=>({
            panelVisible: jQuery('#construkted-popup-settings').is(':visible'),
            fps: (document.getElementById('perf-fps-value')||{}).textContent,
            frameMs: (document.getElementById('perf-frame-ms-value')||{}).textContent,
            gpuMs: (document.getElementById('perf-gpu-ms-value')||{}).textContent,
        }))()`);

        results.elementsExist = await wc.executeJavaScript(`(()=>(
            !!document.getElementById('perf-fps-value') &&
            !!document.getElementById('perf-frame-ms-value') &&
            !!document.getElementById('perf-gpu-ms-value')
        ))()`);

        // Does this build give the timer-query extension at all?
        results.gpuTimerSupported = await wc.executeJavaScript(`(()=>{
            const gl = window.tilesetViewer.viewer.scene.canvas.getContext('webgl2');
            return !!(gl && gl.getExtension('EXT_disjoint_timer_query_webgl2'));
        })()`);
        results.webglVersion = await wc.executeJavaScript(`(()=>{
            const c = window.tilesetViewer.viewer.scene.canvas;
            return c.getContext('webgl2') ? 'webgl2' : 'webgl1-or-none';
        })()`);
        log("gpu timer supported:", results.gpuTimerSupported, "|", results.webglVersion);

        // A. an untouched scene renders nothing, so both values read "idle".
        await sleep(1200);
        results.idleBefore = await readValues();
        log("idle before", JSON.stringify(results.idleBefore));

        // B. request a frame on every animation frame for 2 seconds.
        await wc.executeJavaScript(`(()=>{
            const scene = window.tilesetViewer.viewer.scene;
            window.__perfPump = true;
            (function pump(){
                if(!window.__perfPump) return;
                scene.requestRender();
                requestAnimationFrame(pump);
            })();
            return true;
        })()`);
        await sleep(2000);
        results.underLoad = await readValues();
        log("under load", JSON.stringify(results.underLoad));
        try {
            const img = await wc.capturePage();
            fs.writeFileSync(path.join(__dirname, "traces", "perf-readout.png"), img.toPNG());
            log("screenshot -> tools/traces/perf-readout.png");
        } catch (e) { log("screenshot failed", e.message); }

        // C. stop the frames. Both values must return to "idle".
        await wc.executeJavaScript(`window.__perfPump = false; true`);
        await sleep(1500);
        results.idleAfter = await readValues();
        log("idle after", JSON.stringify(results.idleAfter));

        // D. the version label. It must match the main process, not a bundled
        // copy of package.json, and it must never read "unknown".
        results.version = {
            shown: await wc.executeJavaScript(`(document.getElementById('app-version-value')||{}).textContent`),
            expected: app.getVersion(),
        };
        log("version", JSON.stringify(results.version));

        const fpsText = results.underLoad.fps || "";
        const msText = results.underLoad.frameMs || "";
        const gpuText = (results.underLoad.gpuMs || "").trim();
        const fps = parseFloat(fpsText);
        const frameMs = parseFloat(msText);
        const gpuMs = parseFloat(gpuText);

        // The GPU row is only judged when the extension exists. Without it the
        // row must say so, instead of showing a wrong number.
        const gpuOk = results.gpuTimerSupported
            ? (/ms$/.test(gpuText) && gpuMs > 0)
            : gpuText === "not available";

        results.parsed = {fps, frameMs, gpuMs};
        results.gpuOk = gpuOk;
        results.PASS =
            results.elementsExist === true &&
            results.underLoad.panelVisible === true &&
            results.idleBefore.fps === "idle" &&
            /fps$/.test(fpsText.trim()) && fps > 0 &&
            /ms$/.test(msText.trim()) && frameMs > 0 &&
            gpuOk &&
            results.idleAfter.fps === "idle" &&
            results.idleAfter.frameMs === "idle" &&
            results.version.shown === results.version.expected;

        log("RESULTS", JSON.stringify(results, null, 2));
        log(results.PASS ? "PASS" : "FAIL");
        if (!fs.existsSync(path.join(__dirname, "traces"))) fs.mkdirSync(path.join(__dirname, "traces"), {recursive: true});
        fs.writeFileSync(path.join(__dirname, "traces", "perf-readout-verify.json"), JSON.stringify(results, null, 2));
    } catch (e) {
        console.error("[perf-readout] FAILED", e);
    } finally {
        await sleep(300);
        app.quit();
    }
});
