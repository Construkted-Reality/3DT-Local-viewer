/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// Standalone profiling harness for the perf-cluster findings (M5, requestRenderMode
// umbrella, L-P1). Launches the real renderer bundle + embedded server, auto-loads a
// local sample tileset (bypassing the file dialog), then:
//   1. captures a DevTools-loadable Chromium trace of an idle window, and
//   2. measures hard counters: idle render-loop frequency, postUpdate (credit-patch)
//      frequency, a runtime requestRenderMode before/after, and mirror cost in compare mode.
//
// Run:  DISPLAY=:0 node_modules/.bin/electron tools/profile-harness.js
// Output: tools/traces/*.json  +  tools/traces/summary.json  +  console log.

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");
const {startServer} = require("../server");

const ROOT = path.join(__dirname, "..");
const LEFT_DIR = path.join(ROOT, "postfix-hp");
const RIGHT_DIR = path.join(ROOT, "prefix-hp");
const OUT = path.join(__dirname, "traces");

const IDLE_MS = 4000;   // length of each idle measurement window
const SETTLE_MS = 4000; // let initial tiles stream in before measuring

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) { console.log("[harness]", ...a); }

async function waitForLoad(wc) {
    // addTileset kicks off an async load; tilesetLoaded fires once the tileset
    // is added to the scene. Resolve on it (or immediately if already present).
    await wc.executeJavaScript(`new Promise((resolve) => {
        const v = window.tilesetViewer;
        if (v && v._leftTileset) return resolve(true);
        v.tilesetLoaded.addEventListener(() => resolve(true));
    })`);
}

// Capture a DevTools-timeline trace over `ms` while the page sits idle.
async function captureTrace(wc, label, ms) {
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");

    const chunks = [];
    const onData = (event, method, params) => {
        if (method === "Tracing.dataCollected" && params && params.value) {
            chunks.push(...params.value);
        }
    };
    dbg.on("message", onData);

    await dbg.sendCommand("Tracing.start", {
        traceConfig: {
            includedCategories: [
                "devtools.timeline",
                "disabled-by-default-devtools.timeline",
                "disabled-by-default-devtools.timeline.frame",
                "blink.user_timing",
                "v8",
                "v8.execute",
                "disabled-by-default-v8.cpu_profiler",
            ],
        },
        transferMode: "ReportEvents",
    });

    await sleep(ms);

    const done = new Promise((resolve) => {
        const onComplete = (event, method) => {
            if (method === "Tracing.tracingComplete") {
                dbg.off("message", onComplete);
                resolve();
            }
        };
        dbg.on("message", onComplete);
    });
    await dbg.sendCommand("Tracing.end");
    await done;
    dbg.off("message", onData);

    const file = path.join(OUT, `trace-${label}.json`);
    fs.writeFileSync(file, JSON.stringify({traceEvents: chunks}));
    log(`trace '${label}': ${chunks.length} events -> ${path.relative(ROOT, file)}`);
    return {label, events: chunks.length, file: path.relative(ROOT, file)};
}

// Count renders + postUpdate fires over an idle window, in the current scene state.
async function measureIdle(wc, ms) {
    await wc.executeJavaScript(`(() => {
        const scene = window.tilesetViewer.viewer.scene;
        window.__prof = { renders: 0, postUpdates: 0 };
        window.__profR = () => window.__prof.renders++;
        window.__profP = () => window.__prof.postUpdates++;
        scene.postRender.addEventListener(window.__profR);
        scene.postUpdate.addEventListener(window.__profP);
        return true;
    })()`);
    await sleep(ms);
    const res = await wc.executeJavaScript(`(() => {
        const scene = window.tilesetViewer.viewer.scene;
        scene.postRender.removeEventListener(window.__profR);
        scene.postUpdate.removeEventListener(window.__profP);
        return window.__prof;
    })()`);
    res.seconds = ms / 1000;
    res.rendersPerSec = +(res.renders / res.seconds).toFixed(1);
    res.postUpdatesPerSec = +(res.postUpdates / res.seconds).toFixed(1);
    return res;
}

// Microbenchmark: cost of the 6 jQuery credit-patch DOM ops, as run every frame today.
async function measureCreditPatchCost(wc, iterations) {
    return wc.executeJavaScript(`(() => {
        const N = ${iterations};
        const icon = "x";
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
            jQuery("a[href='https://cesium.com/']").attr('href', "https://cesium.com/cesiumjs/");
            jQuery("img[title='Cesium ion']").attr('src', icon);
            jQuery(".cesium-credit-textContainer").hide();
            jQuery(".cesium-credit-expand-link").show();
            jQuery(".cesium-credit-expand-link").html("Map data attribution");
        }
        const ms = performance.now() - t0;
        return { iterations: N, totalMs: +ms.toFixed(2), perFrameMs: +(ms / N).toFixed(4) };
    })()`);
}

// Decisive before/after for the requestRenderMode umbrella: toggle it at runtime
// and re-measure the idle render frequency.
async function measureRequestRenderMode(wc, ms) {
    await wc.executeJavaScript(`(() => {
        const scene = window.tilesetViewer.viewer.scene;
        scene.requestRenderMode = true;
        scene.maximumRenderTimeChange = Infinity;
        scene.requestRender();
        return true;
    })()`);
    await sleep(500);
    const after = await measureIdle(wc, ms);
    await wc.executeJavaScript(`(() => {
        window.tilesetViewer.viewer.scene.requestRenderMode = false;
        return true;
    })()`);
    return after;
}

// L-P1: mirror cost per frame in compare mode (both slots loaded).
async function measureMirrorCost(wc, iterations) {
    return wc.executeJavaScript(`(() => {
        const v = window.tilesetViewer;
        if (!v._leftTileset || !v._rightTileset) return { error: 'compare mode not active' };
        const mod = window.__mirrorModule;
        // mirrorTilesetSettings isn't exported to window; emulate its per-frame
        // work by copying the same property set the preUpdate listener copies.
        const src = v._leftTileset, dst = v._rightTileset;
        const props = ['maximumScreenSpaceError','cacheBytes','skipLevelOfDetail',
            'debugWireframe','debugShowBoundingVolume','show','pointCloudShading'];
        const N = ${iterations};
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
            for (const p of props) {
                try { dst[p] = src[p]; } catch (e) {}
            }
        }
        const ms = performance.now() - t0;
        return { iterations: N, totalMs: +ms.toFixed(2), perFrameMs: +(ms / N).toFixed(4) };
    })()`);
}

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(async () => {
    const summary = {};
    try {
        if (!fs.existsSync(path.join(LEFT_DIR, "tileset.json"))) {
            throw new Error("sample tileset not found at " + LEFT_DIR);
        }

        log("starting server on 3000 ->", LEFT_DIR);
        await startServer("left", 3000, LEFT_DIR);
        await startServer("right", 3001, RIGHT_DIR);

        const win = new BrowserWindow({
            width: 1280, height: 800, show: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                backgroundThrottling: false,
                preload: path.join(ROOT, "preload.js"),
            },
        });
        const wc = win.webContents;
        wc.on("console-message", (e) => log("[renderer]", e.message));

        await win.loadFile(path.join(ROOT, "web-page/index.html"));
        log("page loaded; waiting for tilesetViewer init");
        await wc.executeJavaScript(`new Promise(r=>{(function c(){window.tilesetViewer?r(true):setTimeout(c,50);})();})`);

        log("loading left tileset");
        await wc.executeJavaScript(`window.tilesetViewer.addTileset("http://localhost:3000/tileset.json","postfix-hp")`);
        await waitForLoad(wc);
        log(`tileset loaded; settling ${SETTLE_MS}ms`);
        await sleep(SETTLE_MS);

        // --- Phase 1: idle baseline (current settings: requestRenderMode OFF) ---
        log("phase 1: idle baseline");
        summary.idleBaseline = await measureIdle(wc, IDLE_MS);
        log("  ", JSON.stringify(summary.idleBaseline));

        // --- Phase 2: DevTools trace of idle window ---
        log("phase 2: capturing idle trace");
        summary.idleTrace = await captureTrace(wc, "idle-baseline", IDLE_MS);

        // --- Phase 3: credit-patch cost (M5) ---
        log("phase 3: credit-patch microbench");
        summary.creditPatch = await measureCreditPatchCost(wc, 2000);
        log("  ", JSON.stringify(summary.creditPatch));

        // --- Phase 4: requestRenderMode ON, re-measure idle (umbrella) ---
        log("phase 4: requestRenderMode ON");
        summary.idleRequestRenderMode = await measureRequestRenderMode(wc, IDLE_MS);
        log("  ", JSON.stringify(summary.idleRequestRenderMode));

        // --- Phase 5: compare mode -> mirror cost (L-P1) ---
        log("phase 5: load right tileset (compare mode)");
        await wc.executeJavaScript(`window.tilesetViewer.addRightTileset("http://localhost:3001/tileset.json","prefix-hp")`);
        await sleep(SETTLE_MS);
        summary.idleCompareMode = await measureIdle(wc, IDLE_MS);
        summary.mirrorCost = await measureMirrorCost(wc, 5000);
        log("  idleCompare", JSON.stringify(summary.idleCompareMode));
        log("  mirrorCost", JSON.stringify(summary.mirrorCost));

        fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
        log("summary -> tools/traces/summary.json");
        log("DONE");
    } catch (err) {
        console.error("[harness] FAILED:", err);
        summary.error = String(err && err.stack || err);
        try { fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2)); } catch (e) {}
    } finally {
        app.quit();
    }
});
