/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// One-off spike: does wrapping scene.pickPositionWorldCoordinates intercept the
// rotate / tilt / zoom pivot pick in Cesium 1.142?  Launches the real renderer,
// loads a sample tileset, wraps that method with a counter, then drives each
// gesture via CDP and reports how many times the camera controller called it.
//
// Decision rule: if a gesture's pivot routes through pickPositionWorldCoordinates,
// the call count is > 0 while the camera demonstrably moved.  A gesture that moved
// the camera with 0 calls uses a different pick path (e.g. ellipsoid) and the wrap
// would NOT snap it.
//
// Run:  DISPLAY=:0 node_modules/.bin/electron tools/pivot-probe.js

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");
const {startServer} = require("../server");

const ROOT = path.join(__dirname, "..");
const LEFT_DIR = path.join(ROOT, "postfix-hp");
const OUT = path.join(__dirname, "traces");
const SETTLE_MS = 4000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) { console.log("[probe]", ...a); }

// The bundled sample (postfix-hp) uses implicit tiling whose subtree files 404, so
// nothing renders and nothing is pickable. The probe needs real geometry, so wrap the
// root GLB (data/0/0/0/0.glb) in a minimal explicit tileset. Regenerated if missing.
function ensureExplicitTileset() {
    const file = path.join(LEFT_DIR, "explicit.json");
    if (fs.existsSync(file)) return;
    const src = JSON.parse(fs.readFileSync(path.join(LEFT_DIR, "tileset.json"), "utf8"));
    fs.writeFileSync(file, JSON.stringify({
        asset: { version: "1.1" },
        geometricError: 10000.0,
        root: {
            boundingVolume: src.root.boundingVolume,
            geometricError: 0.0,
            refine: "REPLACE",
            content: { uri: "data/0/0/0/0.glb" },
        },
    }, null, 2));
    log("generated", file);
}

async function camState(wc) {
    return wc.executeJavaScript(`(()=>{const c=window.tilesetViewer.viewer.camera;
        return {h:c.heading,p:c.pitch,px:c.positionWC.x,py:c.positionWC.y,pz:c.positionWC.z};})()`);
}

function moved(a, b) {
    const d = Math.hypot(a.px - b.px, a.py - b.py, a.pz - b.pz);
    const ang = Math.abs(a.h - b.h) + Math.abs(a.p - b.p);
    return { posDelta: +d.toFixed(3), angleDelta: +ang.toFixed(5) };
}

// Reset the probe counter, run `fn` (which drives a gesture), report call count + cam move.
async function gesture(wc, name, fn) {
    await wc.executeJavaScript(`(()=>{window.__probe.calls=[];window.__probe.on=true;return true;})()`);
    const before = await camState(wc);
    await fn();
    const after = await camState(wc);
    const calls = await wc.executeJavaScript(`(()=>{window.__probe.on=false;return window.__probe.calls.slice();})()`);
    const hits = calls.filter(c => c.hit).length;
    const result = { gesture: name, pickCalls: calls.length, pickHits: hits, cameraMove: moved(before, after) };
    log(name, JSON.stringify(result));
    return result;
}

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(async () => {
    const summary = { cesiumVersion: null, pickPositionSupported: null, gestures: [] };
    try {
        if (!fs.existsSync(path.join(LEFT_DIR, "tileset.json"))) {
            throw new Error("sample tileset not found at " + LEFT_DIR);
        }
        ensureExplicitTileset();
        await startServer("left", 3000, LEFT_DIR);

        const win = new BrowserWindow({
            width: 1280, height: 800, show: true,
            webPreferences: {
                nodeIntegration: false, contextIsolation: true, sandbox: true,
                backgroundThrottling: false,
                preload: path.join(ROOT, "preload.js"),
            },
        });
        const wc = win.webContents;
        wc.on("console-message", (e) => log("[renderer]", e.message));

        await win.loadFile(path.join(ROOT, "web-page/index.html"));
        await wc.executeJavaScript(`new Promise(r=>{(function c(){window.tilesetViewer?r(true):setTimeout(c,50);})();})`);

        await wc.executeJavaScript(`window.tilesetViewer.addTileset("http://localhost:3000/explicit.json","postfix-hp")`);
        await wc.executeJavaScript(`new Promise((resolve)=>{const v=window.tilesetViewer;
            if(v&&v._leftTileset)return resolve(true);v.tilesetLoaded.addEventListener(()=>resolve(true));})`);
        await sleep(SETTLE_MS);

        // Install the wrap + capture environment facts.
        summary.cesiumVersion = await wc.executeJavaScript(`window.Cesium.VERSION`);
        summary.pickPositionSupported = await wc.executeJavaScript(
            `window.tilesetViewer.viewer.scene.pickPositionSupported`);
        await wc.executeJavaScript(`(()=>{
            const Cesium = window.Cesium;
            const scene = window.tilesetViewer.viewer.scene;
            // forcePoint: when set, the wrap returns this fixed world point for every
            // call (simulating "pick always hits") so we can see if rotate orbits it.
            window.__probe = { calls: [], on: false, hits: 0, forcePoint: null };
            const orig = scene.pickPositionWorldCoordinates.bind(scene);
            scene.pickPositionWorldCoordinates = function(pos, result){
                const real = orig(pos, result);
                if (window.__probe.on) {
                    window.__probe.calls.push({x:pos.x,y:pos.y,hit:Cesium.defined(real)});
                    if (Cesium.defined(real)) window.__probe.hits++;
                    if (window.__probe.forcePoint) {
                        return Cesium.Cartesian3.clone(window.__probe.forcePoint, result);
                    }
                }
                return real;
            };
            // expose a valid on-tileset point: the left tileset bounding sphere center.
            const bs = window.tilesetViewer._leftTileset.boundingSphere;
            window.__probe.tilesetCenter = {x:bs.center.x,y:bs.center.y,z:bs.center.z,r:bs.radius};
            return true;
        })()`);
        log("cesium", summary.cesiumVersion, "pickPositionSupported", summary.pickPositionSupported);

        // Diagnostic: scan a coarse grid over the canvas and count how often each
        // pick method returns geometry. Tells us if depth-pick works on this content.
        summary.gridScan = await wc.executeJavaScript(`(()=>{
            const Cesium = window.Cesium;
            const scene = window.tilesetViewer.viewer.scene;
            const c = scene.canvas, W = c.clientWidth, H = c.clientHeight;
            const step = 40; let total=0, depthHit=0, pickPosHit=0, primHit=0;
            const r = new Cesium.Cartesian2();
            let hitPixel = null;
            for (let y=step; y<H; y+=step) for (let x=step; x<W; x+=step){
                total++;
                r.x=x; r.y=y;
                if (Cesium.defined(scene.pickPositionWorldCoordinates(r))) depthHit++;
                if (Cesium.defined(scene.pickPosition(r))) pickPosHit++;
                const p = scene.pick(r);
                if (Cesium.defined(p)) primHit++;
                if (!hitPixel && Cesium.defined(scene.pickPosition(r))) hitPixel = {x,y};
            }
            return {gridPoints:total, depthHit, pickPositionHit:pickPosHit, scenePickHit:primHit,
                    canvas:{W,H}, hitPixel};
        })()`);
        log("gridScan", JSON.stringify(summary.gridScan));

        const dbg = wc.debugger;
        if (!dbg.isAttached()) dbg.attach("1.3");
        win.focus();
        // Aim gestures at a pixel known to be ON the model (from the grid scan).
        // Grid scan used CANVAS coords; CDP uses VIEWPORT coords. Convert via the
        // canvas bounding rect (the menu bar offsets the canvas down by ~30px).
        const rect = await wc.executeJavaScript(`(()=>{const c=window.tilesetViewer.viewer.scene.canvas;
            const r=c.getBoundingClientRect();return {left:r.left,top:r.top};})()`);
        const hp = summary.gridScan.hitPixel || {x:640,y:380};
        const cx = Math.round(hp.x + rect.left), cy = Math.round(hp.y + rect.top);
        summary.canvasRect = rect;
        log("on-model canvas pixel", JSON.stringify(hp), "-> viewport", cx, cy, "rect", JSON.stringify(rect));
        const reZoom = async () => {
            await wc.executeJavaScript(`window.tilesetViewer.viewer.zoomTo(window.tilesetViewer._leftTileset)`);
            await sleep(1200);
        };

        // Left-drag → rotate (spin3D).
        await reZoom();
        summary.gestures.push(await gesture(wc, "left-drag-rotate", async () => {
            await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mousePressed",x:cx,y:cy,button:"left",buttons:1,clickCount:1});
            for (let i=1;i<=15;i++){ await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x:cx+i*5,y:cy+i*2,button:"left",buttons:1}); await sleep(16);}
            await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mouseReleased",x:cx+75,y:cy+30,button:"left",buttons:0,clickCount:1});
            await sleep(50);
        }));

        // Left-drag again, but FORCE every pick to return the tileset-center point.
        // If rotate orbits the pivot, posDelta will jump. Re-zoom first to reset the
        // camera and clear Cesium's cached pivot so the wrap is actually re-invoked.
        await reZoom();
        await wc.executeJavaScript(`(()=>{window.__probe.forcePoint=window.__probe.tilesetCenter;return true;})()`);
        summary.gestures.push(await gesture(wc, "left-drag-rotate-forcedpivot", async () => {
            await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mousePressed",x:cx,y:cy,button:"left",buttons:1,clickCount:1});
            for (let i=1;i<=15;i++){ await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x:cx+i*5,y:cy+i*2,button:"left",buttons:1}); await sleep(16);}
            await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mouseReleased",x:cx+75,y:cy+30,button:"left",buttons:0,clickCount:1});
            await sleep(50);
        }));
        await wc.executeJavaScript(`(()=>{window.__probe.forcePoint=null;return true;})()`);

        // Right-drag → tilt (tilt3D).
        summary.gestures.push(await gesture(wc, "right-drag-tilt", async () => {
            await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mousePressed",x:cx,y:cy,button:"right",buttons:2,clickCount:1});
            for (let i=1;i<=15;i++){ await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x:cx,y:cy+i*4,button:"right",buttons:2}); await sleep(16);}
            await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mouseReleased",x:cx,y:cy+60,button:"right",buttons:0,clickCount:1});
            await sleep(50);
        }));

        // Wheel → zoom (zoom3D).
        summary.gestures.push(await gesture(wc, "wheel-zoom", async () => {
            for (let i=0;i<6;i++){ await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseWheel",x:cx,y:cy,deltaX:0,deltaY:-120}); await sleep(40);}
        }));

        // Middle-drag → zoom (this app maps MIDDLE_DRAG to zoom).
        summary.gestures.push(await gesture(wc, "middle-drag-zoom", async () => {
            await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mousePressed",x:cx,y:cy,button:"middle",buttons:4,clickCount:1});
            for (let i=1;i<=12;i++){ await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x:cx,y:cy-i*4,button:"middle",buttons:4}); await sleep(16);}
            await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mouseReleased",x:cx,y:cy-48,button:"middle",buttons:0,clickCount:1});
            await sleep(50);
        }));

        if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, {recursive:true});
        fs.writeFileSync(path.join(OUT, "pivot-probe.json"), JSON.stringify(summary, null, 2));
        log("summary -> tools/traces/pivot-probe.json");
        log("DONE");
    } catch (e) {
        console.error("[probe] FAILED", e);
    } finally {
        await sleep(300);
        app.quit();
    }
});
