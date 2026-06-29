/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// Verification for the RotationCenterSnap feature against the REAL app bundle.
// Launches the renderer, loads a pickable tileset, then checks:
//   A. _resolve snaps a near-miss pixel (within R px of geometry) to a point,
//      and returns nothing for a pixel far from any geometry.
//   B. left-down shows the rotation-centre marker at a world point; left-up hides it.
//   C. left-drag actually orbits the snapped pivot (camera position moves).
//   D. fly mode leaves the marker hidden (snap inert).
//
// Run:  DISPLAY=:0 node_modules/.bin/electron tools/verify-snap.js

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");
const {startServer} = require("../server");

const ROOT = path.join(__dirname, "..");
const LEFT_DIR = path.join(ROOT, "postfix-hp");
const SETTLE_MS = 4000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) { console.log("[verify]", ...a); }

// The bundled sample uses implicit tiling whose subtrees 404 (nothing renders, nothing
// is pickable). Wrap the root GLB in a minimal explicit tileset so there's real geometry
// to snap against. Regenerated if missing.
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

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(async () => {
    const results = {};
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
        await sleep(SETTLE_MS);

        results.snapInstalled = await wc.executeJavaScript(`!!window.tilesetViewer._rotationCenterSnap`);
        results.markerExists = await wc.executeJavaScript(`!!window.tilesetViewer._rotationCenterSnap._markerEl`);

        // A. _resolve unit check. Find an on-model pixel, a near-miss pixel (raw
        // miss but a hit within R), and a far pixel (no hit within R).
        results.resolveCheck = await wc.executeJavaScript(`(()=>{
            const Cesium = window.Cesium;
            const snap = window.tilesetViewer._rotationCenterSnap;
            const scene = window.tilesetViewer.viewer.scene;
            const orig = snap._origPick;
            const R = 16;
            const c = scene.canvas, W = c.clientWidth, H = c.clientHeight;
            const r = new Cesium.Cartesian2();
            const rawHit = (x,y)=>{r.x=x;r.y=y;return Cesium.defined(orig(r));};
            let onModel=null, nearMiss=null, far=null;
            for (let y=8; y<H && (!onModel||!nearMiss||!far); y+=8)
            for (let x=8; x<W && (!onModel||!nearMiss||!far); x+=8){
                const hit = rawHit(x,y);
                if (hit && !onModel) onModel={x,y};
                if (!hit){
                    // does any neighbour within R hit?
                    let near=false;
                    for(let a=0;a<8;a++){const ang=2*Math.PI*a/8;
                        if(rawHit(x+R*Math.cos(ang), y+R*Math.sin(ang))){near=true;break;}}
                    if (near && !nearMiss) nearMiss={x,y};
                    // far: no hit within 3R either
                    if (!near && !far){
                        let anyFar=false;
                        for(let a=0;a<8;a++){const ang=2*Math.PI*a/8;
                            if(rawHit(x+3*R*Math.cos(ang), y+3*R*Math.sin(ang))){anyFar=true;break;}}
                        if(!anyFar) far={x,y};
                    }
                }
            }
            const resolved = (p)=> p ? Cesium.defined(snap._resolve(new Cesium.Cartesian2(p.x,p.y))) : null;
            return {
                onModel, nearMiss, far,
                onModel_resolves: resolved(onModel),
                nearMiss_rawMiss: nearMiss ? !rawHit(nearMiss.x,nearMiss.y) : null,
                nearMiss_resolves: resolved(nearMiss),   // EXPECT true (snapped)
                far_resolves: resolved(far),             // EXPECT false (no snap)
            };
        })()`);
        log("resolveCheck", JSON.stringify(results.resolveCheck));

        // viewport offset for CDP (menu bar pushes canvas down).
        const rect = await wc.executeJavaScript(`(()=>{const c=window.tilesetViewer.viewer.scene.canvas;
            const r=c.getBoundingClientRect();return {left:r.left,top:r.top};})()`);
        const onModel = results.resolveCheck.onModel || {x:600,y:500};
        const cx = Math.round(onModel.x + rect.left), cy = Math.round(onModel.y + rect.top);

        const dbg = wc.debugger;
        if (!dbg.isAttached()) dbg.attach("1.3");
        win.focus();
        await wc.executeJavaScript(`window.tilesetViewer.viewer.zoomTo(window.tilesetViewer._leftTileset)`);
        await sleep(1200);

        // B + C. left-down -> marker shows; drag -> orbit; up -> hide.
        await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mousePressed",x:cx,y:cy,button:"left",buttons:1,clickCount:1});
        await sleep(50);
        const camBefore = await wc.executeJavaScript(`(()=>{const p=window.tilesetViewer.viewer.camera.positionWC;return{x:p.x,y:p.y,z:p.z};})()`);
        results.markerShownOnDown = await wc.executeJavaScript(`(()=>{const m=window.tilesetViewer._rotationCenterSnap;
            return {show:m._markerEl.style.display==='block', hasPos: window.Cesium.defined(m._markerWorld) };})()`);
        for (let i=1;i<=15;i++){ await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x:cx+i*5,y:cy+i*2,button:"left",buttons:1}); await sleep(16);}
        const camAfter = await wc.executeJavaScript(`(()=>{const p=window.tilesetViewer.viewer.camera.positionWC;return{x:p.x,y:p.y,z:p.z};})()`);
        // Capture the window mid-drag so the rotation-centre marker is visible.
        try {
            const img = await wc.capturePage();
            fs.writeFileSync(path.join(__dirname,"traces","verify-snap-marker.png"), img.toPNG());
            log("screenshot -> tools/traces/verify-snap-marker.png");
        } catch (e) { log("screenshot failed", e.message); }
        await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mouseReleased",x:cx+75,y:cy+30,button:"left",buttons:0,clickCount:1});
        await sleep(50);
        results.markerHiddenOnUp = await wc.executeJavaScript(`window.tilesetViewer._rotationCenterSnap._markerEl.style.display === 'none'`);
        results.orbitPosDelta = +Math.hypot(camAfter.x-camBefore.x, camAfter.y-camBefore.y, camAfter.z-camBefore.z).toFixed(2);

        // D. fly mode -> marker stays hidden.
        await wc.executeJavaScript(`window.tilesetViewer.flyController.start(); true`);
        await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mousePressed",x:cx,y:cy,button:"left",buttons:1,clickCount:1});
        await sleep(50);
        results.markerHiddenInFly = await wc.executeJavaScript(`window.tilesetViewer._rotationCenterSnap._markerEl.style.display === 'none'`);
        await dbg.sendCommand("Input.dispatchMouseEvent", {type:"mouseReleased",x:cx,y:cy,button:"left",buttons:0,clickCount:1});
        await wc.executeJavaScript(`window.tilesetViewer.flyController.stop(); true`);

        const rc = results.resolveCheck;
        results.PASS =
            results.snapInstalled && results.markerExists &&
            rc.onModel_resolves === true &&
            rc.nearMiss_rawMiss === true && rc.nearMiss_resolves === true &&
            rc.far_resolves === false &&
            results.markerShownOnDown.show === true &&
            results.markerHiddenOnUp === true &&
            results.orbitPosDelta > 0 &&
            results.markerHiddenInFly === true;

        log("RESULTS", JSON.stringify(results, null, 2));
        log(results.PASS ? "PASS" : "FAIL");
        if (!fs.existsSync(path.join(__dirname,"traces"))) fs.mkdirSync(path.join(__dirname,"traces"),{recursive:true});
        fs.writeFileSync(path.join(__dirname,"traces","verify-snap.json"), JSON.stringify(results,null,2));
    } catch (e) {
        console.error("[verify] FAILED", e);
    } finally {
        await sleep(300);
        app.quit();
    }
});
