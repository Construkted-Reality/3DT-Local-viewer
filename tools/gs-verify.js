/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// Verify the Gaussian-splat pivot snapping (SplatPivotSource) against the real app
// bundle + a real KHR_gaussian_splatting tileset. Introspects the splat source,
// grid-scans _resolve hits, drives a rotate, checks the marker + orbit, screenshots.
// The splat tileset isn't in the repo (like the mesh samples); point GS_TILESET_DIR at a
// directory containing its tileset.json.
//
// Run:  GS_TILESET_DIR=/path/to/gs-tileset DISPLAY=:0 node_modules/.bin/electron tools/gs-verify.js

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");
const {startServer} = require("../server");

const GS_DIR = process.env.GS_TILESET_DIR;
const SETTLE_MS = 7000;
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function log(...a){console.log("[gsv]",...a);}

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(async () => {
    const out = {errors:[]};
    try {
        if (!GS_DIR || !fs.existsSync(path.join(GS_DIR, "tileset.json"))) {
            throw new Error("set GS_TILESET_DIR to a dir containing a Gaussian-splat tileset.json");
        }
        await startServer("left", 3000, GS_DIR);
        const win = new BrowserWindow({width:1280,height:800,show:true,webPreferences:{
            nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,
            preload:path.join(__dirname,"..","preload.js")}});
        const wc = win.webContents;
        wc.on("console-message",(e)=>{const m=e.message;log("[renderer]",m);
            if(/error|out of bounds|exception/i.test(m))out.errors.push(m);});
        await win.loadFile(path.join(__dirname,"..","web-page/index.html"));
        await wc.executeJavaScript(`new Promise(r=>{(function c(){window.tilesetViewer?r(true):setTimeout(c,50);})();})`);
        await wc.executeJavaScript(`window.tilesetViewer.addTileset("http://localhost:3000/tileset.json","geo_pc30")`);
        await wc.executeJavaScript(`new Promise((res)=>{const v=window.tilesetViewer;if(v&&v._leftTileset)return res(true);v.tilesetLoaded.addEventListener(()=>res(true));})`).catch(()=>{});
        await sleep(SETTLE_MS);

        // Introspect splat source + color layout.
        out.diag = await wc.executeJavaScript(`(()=>{
            const C=window.Cesium, t=window.tilesetViewer._leftTileset;
            const snap=window.tilesetViewer._rotationCenterSnap, src=snap._splatSource;
            const gsp=t.gaussianSplatPrimitive, colors=gsp&&gsp._colors;
            let aMin=Infinity,aMax=-Infinity,alphaSample=[];
            if(colors){const step=Math.ceil(gsp._numSplats/2000);
                for(let i=0;i<gsp._numSplats;i+=step){const a=colors[i*4+3];if(a<aMin)aMin=a;if(a>aMax)aMax=a;}
                for(let i=0;i<8;i++)alphaSample.push(colors[i*4+3]);}
            let centersLen=null,qMid=null;
            if(src){src._ensureFresh();centersLen=src._centers.length;
                qMid=!!src.query(window.tilesetViewer.viewer.scene,new C.Cartesian2(625,400),28);}
            return {splatSourcePresent:!!src,numSplats:gsp&&gsp._numSplats,
                colorsCtor:colors&&colors.constructor.name,colorsLen:colors&&colors.length,
                alphaMin:aMin,alphaMax:aMax,alphaSample,centersLen,centerQueryAtMid:qMid};
        })()`);
        log("diag", JSON.stringify(out.diag));

        // Grid scan of _resolve hits over the splats.
        out.gridScan = await wc.executeJavaScript(`(()=>{
            const C=window.Cesium,s=window.tilesetViewer.viewer.scene;
            const snap=window.tilesetViewer._rotationCenterSnap,c=s.canvas;
            const W=c.clientWidth,H=c.clientHeight,step=24;let tot=0,hit=0,hp=null;
            const cxp=W/2,cyp=H/2;let bestD=Infinity;
            for(let y=step;y<H;y+=step)for(let x=step;x<W;x+=step){tot++;
                if(C.defined(snap._resolve(new C.Cartesian2(x,y)))){hit++;
                    const d=(x-cxp)*(x-cxp)+(y-cyp)*(y-cyp); if(d<bestD){bestD=d;hp={x,y};}}}
            return {total:tot,resolveHit:hit,hitPixel:hp};
        })()`);
        log("gridScan", JSON.stringify(out.gridScan));

        // Drive a rotate over a splat pixel; check marker + orbit.
        const rect = await wc.executeJavaScript(`(()=>{const c=window.tilesetViewer.viewer.scene.canvas;const r=c.getBoundingClientRect();return{left:r.left,top:r.top};})()`);
        const hp = out.gridScan.hitPixel || {x:625,y:400};
        const cx=Math.round(hp.x+rect.left), cy=Math.round(hp.y+rect.top);
        const dbg=wc.debugger; if(!dbg.isAttached())dbg.attach("1.3"); win.focus();
        const camBefore=await wc.executeJavaScript(`(()=>{const p=window.tilesetViewer.viewer.camera.positionWC;return{x:p.x,y:p.y,z:p.z};})()`);
        await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mousePressed",x:cx,y:cy,button:"left",buttons:1,clickCount:1});
        await sleep(80);
        out.markerOnDown=await wc.executeJavaScript(`window.tilesetViewer._rotationCenterSnap._markerEl.style.display==='block'`);
        // Clean visual: marker on the splat at mouse-down, before the camera moves.
        try{const img=await wc.capturePage();fs.writeFileSync(path.join(__dirname,"traces","gs-verify-marker.png"),img.toPNG());}catch(e){}
        for(let i=1;i<=15;i++){await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x:cx+i*5,y:cy+i*2,button:"left",buttons:1});await sleep(20);}
        const camAfter=await wc.executeJavaScript(`(()=>{const p=window.tilesetViewer.viewer.camera.positionWC;return{x:p.x,y:p.y,z:p.z};})()`);
        await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseReleased",x:cx+75,y:cy+30,button:"left",buttons:0,clickCount:1});
        out.orbitPosDelta=+Math.hypot(camAfter.x-camBefore.x,camAfter.y-camBefore.y,camAfter.z-camBefore.z).toFixed(2);

        try{const img=await wc.capturePage();fs.writeFileSync(path.join(__dirname,"traces","gs-verify.png"),img.toPNG());}catch(e){}

        out.PASS = out.gridScan.resolveHit>0 && out.markerOnDown===true && out.orbitPosDelta>0 && out.errors.length===0;
        out.summary=`resolveHits=${out.gridScan.resolveHit}/${out.gridScan.total} marker=${out.markerOnDown} orbit=${out.orbitPosDelta} crash=${out.errors.length>0}`;
        log("RESULT", out.summary, out.PASS?"PASS":"FAIL");
        fs.writeFileSync(path.join(__dirname,"traces","gs-verify.json"),JSON.stringify(out,null,2));
    }catch(e){console.error("[gsv] FAILED",e);}
    finally{await sleep(300);app.quit();}
});
