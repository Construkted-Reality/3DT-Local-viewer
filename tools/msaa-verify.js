/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// Verification for the MSAA (multisampling) setting against the REAL app bundle.
// Launches the renderer, loads a tileset, then checks:
//   A. the select exists and offers 1 / 2 / 4.
//   B. the initial select value matches scene.msaaSamples.
//   C. each option writes that value to scene.msaaSamples and renders a frame.
//
// Run:  DISPLAY=:0 node_modules/.bin/electron tools/msaa-verify.js

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");
const {startServer} = require("../server");

const ROOT = path.join(__dirname, "..");
const LEFT_DIR = path.join(ROOT, "postfix-hp");
const SETTLE_MS = 3000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) { console.log("[msaa]", ...a); }

// Same explicit-tileset shim as verify-snap.js: the sample's implicit subtrees 404,
// so wrap the root GLB in a minimal explicit tileset to get real geometry on screen.
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

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(async () => {
    const results = {};
    try {
        // The sample tileset is optional here: the MSAA control is a scene-level
        // setting and does not need loaded content. Load it when it is present so
        // the screenshots show real geometry.
        const haveSample = fs.existsSync(path.join(LEFT_DIR, "tileset.json"));

        if (haveSample) {
            ensureExplicitTileset();
            await startServer("left", 3000, LEFT_DIR);
        } else {
            log("no sample tileset at", LEFT_DIR, "- running against an empty scene");
        }

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
            await wc.executeJavaScript(`window.tilesetViewer.addTileset("http://localhost:3000/explicit.json","postfix-hp")`);
            await wc.executeJavaScript(`new Promise((resolve)=>{const v=window.tilesetViewer;
                if(v&&v._leftTileset)return resolve(true);v.tilesetLoaded.addEventListener(()=>resolve(true));})`);
        }

        await sleep(SETTLE_MS);

        results.control = await wc.executeJavaScript(`(()=>{
            const el = document.getElementById('msaa-samples-select');
            if (!el) return {exists:false};
            return {
                exists: true,
                options: Array.from(el.options).map(o=>o.value),
                labels: Array.from(el.options).map(o=>o.textContent.trim()),
                disabled: el.disabled,
                value: el.value,
            };
        })()`);
        results.msaaSupported = await wc.executeJavaScript(`window.tilesetViewer.viewer.scene.msaaSupported`);
        results.sceneSamplesAtStart = await wc.executeJavaScript(`window.tilesetViewer.viewer.scene.msaaSamples`);

        // C. drive the control the way a user does: set the value, fire 'change'.
        results.applied = [];
        for (const value of ["1", "2", "4"]) {
            const applied = await wc.executeJavaScript(`(()=>{
                jQuery('#msaa-samples-select').val('${value}').trigger('change');
                return window.tilesetViewer.viewer.scene.msaaSamples;
            })()`);
            await sleep(600);
            results.applied.push({selected: value, sceneSamples: applied});
            log("selected", value, "-> scene.msaaSamples", applied);
            try {
                const img = await wc.capturePage();
                fs.writeFileSync(path.join(__dirname, "traces", `msaa-${value}.png`), img.toPNG());
            } catch (e) { log("screenshot failed", e.message); }
        }

        // The renderer must survive the switches (a lost context would clear this).
        results.sceneAliveAtEnd = await wc.executeJavaScript(`(()=>{
            const s = window.tilesetViewer.viewer.scene;
            s.requestRender();
            return !s.isDestroyed() && s.canvas.width > 0;
        })()`);

        const c = results.control;
        results.PASS =
            c.exists === true &&
            c.options.join(",") === "1,2,4" &&
            results.msaaSupported === true &&
            c.disabled === false &&
            parseInt(c.value, 10) === results.sceneSamplesAtStart &&
            results.applied.every(a => parseInt(a.selected, 10) === a.sceneSamples) &&
            results.sceneAliveAtEnd === true;

        log("RESULTS", JSON.stringify(results, null, 2));
        log(results.PASS ? "PASS" : "FAIL");
        if (!fs.existsSync(path.join(__dirname, "traces"))) fs.mkdirSync(path.join(__dirname, "traces"), {recursive: true});
        fs.writeFileSync(path.join(__dirname, "traces", "msaa-verify.json"), JSON.stringify(results, null, 2));
    } catch (e) {
        console.error("[msaa] FAILED", e);
    } finally {
        await sleep(300);
        app.quit();
    }
});
