/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// Verification for the dynamic multisampling feature against the REAL app bundle.
// It launches the renderer, loads a tileset, then drags the camera two times:
// one drag with the feature ON and one drag with the feature OFF. It checks the
// behaviour and it measures what the feature buys and what it costs.
//
// Checks:
//   A. the toggle exists, is on at start, and is enabled.
//   B. the camera at rest holds the chosen sample count (4).
//   C. every frame of the drag draws at 1 sample while the feature is on.
//   D. the camera at rest again holds 4 samples, and the drag paid for exactly
//      two writes of scene.msaaSamples.
//   E. the feature off keeps 4 samples for every frame of the drag.
//
// Measurements (written to tools/traces/dynamic-msaa-verify.json):
//   - the mean GPU time and the mean CPU time of a drag frame, feature on and
//     feature off. The difference is what the feature buys.
//   - the time of the first frame after each change of the sample count. That
//     frame rebuilds the scene framebuffer, so it is the cost of the feature.
//
// Run:  DISPLAY=:0 node_modules/.bin/electron tools/dynamic-msaa-verify.js

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");
const {startServer} = require("../server");

const ROOT = path.join(__dirname, "..");
const LEFT_DIR = path.join(ROOT, "postfix-hp");
const SETTLE_MS = 3000;
const DRAG_STEPS = 40;
const DRAG_STEP_MS = 16;

// Longer than DynamicMsaa's IDLE_MS (250 ms), so the restore has fired.
const REST_MS = 700;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) { console.log("[dyn-msaa]", ...a); }
function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }

// Same explicit-tileset shim as msaa-verify.js: the sample's implicit subtrees
// 404, so wrap the root GLB in a minimal explicit tileset to get real geometry.
function ensureExplicitTileset() {
    const file = path.join(LEFT_DIR, "explicit.json");
    if (fs.existsSync(file)) return;
    const src = JSON.parse(fs.readFileSync(path.join(LEFT_DIR, "tileset.json"), "utf8"));
    fs.writeFileSync(file, JSON.stringify({
        asset: {version: "1.1"},
        geometricError: 10000.0,
        root: {
            boundingVolume: src.root.boundingVolume,
            geometricError: 0.0,
            refine: "REPLACE",
            content: {uri: "data/0/0/0/0.glb"},
        },
    }, null, 2));
    log("generated", file);
}

// Records one row per drawn frame: the CPU time of the render call, the GPU
// time of the same span, and the sample count that the frame drew with. The
// GPU query answers a few frames late, so the rows carry a query index and
// read() fills the GPU column in at the end.
const PROBE_SOURCE = `window.__msaaProbe = (function () {
    const scene = window.tilesetViewer.viewer.scene;
    const gl = scene.canvas.getContext('webgl2');
    const ext = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    const rows = [];
    let start = 0;
    let query = null;

    scene.preRender.addEventListener(function () {
        start = performance.now();
        if (ext) {
            query = gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        }
    });

    scene.postRender.addEventListener(function () {
        if (ext) gl.endQuery(ext.TIME_ELAPSED_EXT);
        rows.push({cpuMs: performance.now() - start, samples: scene.msaaSamples, query: query, gpuMs: null});
        query = null;
    });

    return {
        reset: function () { rows.length = 0; },
        gpuSupported: ext !== null && ext !== undefined,
        read: function () {
            const out = [];
            for (const row of rows) {
                if (ext && row.query && gl.getQueryParameter(row.query, gl.QUERY_RESULT_AVAILABLE)
                    && !gl.getParameter(ext.GPU_DISJOINT_EXT)) {
                    row.gpuMs = gl.getQueryParameter(row.query, gl.QUERY_RESULT) / 1e6;
                }
                out.push({cpuMs: row.cpuMs, gpuMs: row.gpuMs, samples: row.samples});
            }
            return out;
        },
    };
})(); true`;

// Chromium hides the timer-query extension unless the main process asks for the
// draft extensions. index.js does the same for the app itself.
app.commandLine.appendSwitch("enable-webgl-draft-extensions");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(async () => {
    const results = {};
    try {
        if (!fs.existsSync(path.join(LEFT_DIR, "tileset.json"))) {
            log("no sample tileset at", LEFT_DIR, "- this check needs real geometry to draw");
            app.quit();
            return;
        }

        ensureExplicitTileset();
        await startServer("left", 3000, LEFT_DIR);

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
        await wc.executeJavaScript(`window.tilesetViewer.addTileset("http://localhost:3000/explicit.json","postfix-hp")`);
        await wc.executeJavaScript(`new Promise((resolve)=>{const v=window.tilesetViewer;
            if(v&&v._leftTileset)return resolve(true);v.tilesetLoaded.addEventListener(()=>resolve(true));})`);
        await wc.executeJavaScript(`window.tilesetViewer.viewer.zoomTo(window.tilesetViewer._leftTileset)`);
        await sleep(SETTLE_MS);

        // A. the toggle.
        results.toggle = await wc.executeJavaScript(`(()=>{
            const el = document.getElementById('msaa-dynamic-checkbox');
            if (!el) return {exists:false};
            return {exists:true, checked:el.checked, disabled:el.disabled};
        })()`);
        log("toggle", JSON.stringify(results.toggle));

        await wc.executeJavaScript(PROBE_SOURCE);
        results.gpuTimerAvailable = await wc.executeJavaScript(`window.__msaaProbe.gpuSupported`);

        const rect = await wc.executeJavaScript(`(()=>{const c=window.tilesetViewer.viewer.scene.canvas;
            const r=c.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()`);
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2);

        const dbg = wc.debugger;
        if (!dbg.isAttached()) dbg.attach("1.3");
        win.focus();

        // One left-drag that orbits the camera. Returns the frames it drew.
        async function dragAndRecord(label) {
            await wc.executeJavaScript(`window.__msaaProbe.reset()`);
            await dbg.sendCommand("Input.dispatchMouseEvent",
                {type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1});

            for (let i = 1; i <= DRAG_STEPS; ++i) {
                await dbg.sendCommand("Input.dispatchMouseEvent",
                    {type: "mouseMoved", x: cx + i * 3, y: cy + i, button: "left", buttons: 1});
                await sleep(DRAG_STEP_MS);
            }

            await dbg.sendCommand("Input.dispatchMouseEvent",
                {type: "mouseReleased", x: cx + DRAG_STEPS * 3, y: cy + DRAG_STEPS, button: "left", buttons: 0, clickCount: 1});

            const during = await wc.executeJavaScript(`window.__msaaProbe.read()`);
            await sleep(REST_MS);
            const all = await wc.executeJavaScript(`window.__msaaProbe.read()`);

            log(label, "frames during drag", during.length, "frames total", all.length);

            return {during, all};
        }

        // Feature ON, Full multisampling.
        await wc.executeJavaScript(`jQuery('#msaa-dynamic-checkbox').prop('checked', true).trigger('change');
            jQuery('#msaa-samples-select').val('4').trigger('change'); true`);
        await sleep(REST_MS);

        results.samplesAtRestBeforeOn = await wc.executeJavaScript(`window.tilesetViewer.viewer.scene.msaaSamples`);
        const transitionsBefore = await wc.executeJavaScript(`window.tilesetViewer.dynamicMsaa.transitions`);

        const on = await dragAndRecord("feature ON");

        results.samplesAtRestAfterOn = await wc.executeJavaScript(`window.tilesetViewer.viewer.scene.msaaSamples`);
        results.transitionsForOneDrag =
            await wc.executeJavaScript(`window.tilesetViewer.dynamicMsaa.transitions`) - transitionsBefore;

        // Feature OFF, still Full multisampling.
        await wc.executeJavaScript(`jQuery('#msaa-dynamic-checkbox').prop('checked', false).trigger('change'); true`);
        await sleep(REST_MS);

        const off = await dragAndRecord("feature OFF");

        results.samplesAtRestAfterOff = await wc.executeJavaScript(`window.tilesetViewer.viewer.scene.msaaSamples`);

        // The frames of a drag, without the transition frames. A transition
        // frame rebuilds the framebuffer and is reported on its own.
        function split(frames) {
            const body = [];
            const transition = [];
            let previous = null;

            for (const frame of frames) {
                if (previous !== null && frame.samples !== previous) transition.push(frame);
                else body.push(frame);
                previous = frame.samples;
            }

            return {body, transition};
        }

        const onSplit = split(on.all);
        const offSplit = split(off.all);

        results.measurements = {
            featureOn: {
                dragFrames: on.during.length,
                samplesSeenDuringDrag: Array.from(new Set(on.during.map(f => f.samples))),
                meanCpuMs: mean(onSplit.body.map(f => f.cpuMs)),
                meanGpuMs: mean(onSplit.body.map(f => f.gpuMs).filter(v => v !== null)),
                transitionFrames: onSplit.transition.map(f => ({samples: f.samples, cpuMs: f.cpuMs, gpuMs: f.gpuMs})),
            },
            featureOff: {
                dragFrames: off.during.length,
                samplesSeenDuringDrag: Array.from(new Set(off.during.map(f => f.samples))),
                meanCpuMs: mean(offSplit.body.map(f => f.cpuMs)),
                meanGpuMs: mean(offSplit.body.map(f => f.gpuMs).filter(v => v !== null)),
                transitionFrames: offSplit.transition.map(f => ({samples: f.samples, cpuMs: f.cpuMs, gpuMs: f.gpuMs})),
            },
        };

        const t = results.toggle;
        results.PASS =
            t.exists === true &&
            t.checked === true &&
            t.disabled === false &&
            results.samplesAtRestBeforeOn === 4 &&
            on.during.length > 0 &&
            results.measurements.featureOn.samplesSeenDuringDrag.join(",") === "1" &&
            results.samplesAtRestAfterOn === 4 &&
            results.transitionsForOneDrag === 2 &&
            off.during.length > 0 &&
            results.measurements.featureOff.samplesSeenDuringDrag.join(",") === "4" &&
            results.samplesAtRestAfterOff === 4;

        log("RESULTS", JSON.stringify(results, null, 2));
        log(results.PASS ? "PASS" : "FAIL");

        if (!fs.existsSync(path.join(__dirname, "traces"))) fs.mkdirSync(path.join(__dirname, "traces"), {recursive: true});
        fs.writeFileSync(path.join(__dirname, "traces", "dynamic-msaa-verify.json"), JSON.stringify(results, null, 2));
    } catch (e) {
        console.error("[dyn-msaa] FAILED", e);
    } finally {
        await sleep(300);
        app.quit();
    }
});
