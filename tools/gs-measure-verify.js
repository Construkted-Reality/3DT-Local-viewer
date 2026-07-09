/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// Verify GS MEASUREMENT (two-pass refined picking + the MeasureTool) against the real app
// bundle + a real KHR_gaussian_splatting tileset. Complements tools/gs-verify.js (pivot
// snapping). The splat tileset isn't in the repo; point GS_TILESET_DIR at a dir with its
// tileset.json.
//
// Run:  GS_TILESET_DIR=/path/to/gs-tileset DISPLAY=:0 node_modules/.bin/electron tools/gs-measure-verify.js
//
// Checks (see docs/plans/2026-07-09-gs-measurement-plan.md):
//   H1  refine().nearest == an independent in-page brute-force nearest over all centres
//   H2  decimated-pick vs refined-pick distance (min/median/max metres) — the precision delta
//   H3  two refined picks reproduce a known centre-to-centre distance within reported ±
//   timings: rebuild / per-frame query / per-click refine (ms)
//   overlay: drive the MEASURE button + two synthetic clicks; assert overlay + screenshot

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");
const {startServer} = require("../server");

const GS_DIR = process.env.GS_TILESET_DIR;
const SETTLE_MS = 7000;
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function log(...a){console.log("[gsm]",...a);}

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

        // Introspect + find a splat pixel near screen centre (rebuild timing captured here).
        out.diag = await wc.executeJavaScript(`(()=>{
            const C=window.Cesium,s=window.tilesetViewer.viewer.scene;
            const snap=window.tilesetViewer._rotationCenterSnap,src=snap._splatSource;
            const t=window.tilesetViewer._leftTileset,gsp=t.gaussianSplatPrimitive;
            const tRb=performance.now();src&&src._ensureFresh();const rebuildMs=performance.now()-tRb;
            const c=s.canvas,W=c.clientWidth,H=c.clientHeight,step=24;
            let tot=0,hit=0,hp=null,bestD=Infinity;const cxp=W/2,cyp=H/2;
            for(let y=step;y<H;y+=step)for(let x=step;x<W;x+=step){tot++;
                if(C.defined(snap._resolve(new C.Cartesian2(x,y)))){hit++;
                    const d=(x-cxp)*(x-cxp)+(y-cyp)*(y-cyp);if(d<bestD){bestD=d;hp={x,y};}}}
            return {numSplats:gsp&&gsp._numSplats,centersLen:src&&src._centers.length,
                rebuildMs:+rebuildMs.toFixed(2),resolveHit:hit,total:tot,hitPixel:hp};
        })()`);
        log("diag", JSON.stringify(out.diag));
        if (!out.diag.hitPixel) throw new Error("no splat pixel found on screen");

        // H1 + timings: refine at the hit pixel; brute-force nearest independently.
        out.h1 = await wc.executeJavaScript(`(()=>{
            const C=window.Cesium,s=window.tilesetViewer.viewer.scene;
            const snap=window.tilesetViewer._rotationCenterSnap,src=snap._splatSource;
            const t=window.tilesetViewer._leftTileset,gsp=t.gaussianSplatPrimitive;
            const px=new C.Cartesian2(${out.diag.hitPixel.x},${out.diag.hitPixel.y});
            const tQ=performance.now();const coarse=src.query(s,px,28);const queryMs=performance.now()-tQ;
            if(!coarse)return {ok:false,reason:'no coarse'};
            const refined=src.refine(s,coarse,12);
            if(!refined)return {ok:false,reason:'no refine'};
            // Brute-force nearest full-density centre to coarse (world space).
            const pos=gsp._positions,rt=gsp._rootTransform,n=gsp._numSplats;
            const lp=new C.Cartesian3(),wp=new C.Cartesian3();let bi=-1,bd=Infinity;
            for(let i=0;i<n;i++){lp.x=pos[i*3];lp.y=pos[i*3+1];lp.z=pos[i*3+2];
                C.Matrix4.multiplyByPoint(rt,lp,wp);const d=C.Cartesian3.distanceSquared(wp,coarse);
                if(d<bd){bd=d;bi=i;}}
            lp.x=pos[bi*3];lp.y=pos[bi*3+1];lp.z=pos[bi*3+2];C.Matrix4.multiplyByPoint(rt,lp,wp);
            const nearErr=C.Cartesian3.distance(refined.nearest,wp);
            return {ok:true,queryMs:+queryMs.toFixed(3),refineMs:+refined.ms.toFixed(3),
                lastQueryMs:+(src._lastQueryMs||0).toFixed(3),count:refined.count,
                spread:+refined.spread.toFixed(4),nearestErr:+nearErr.toFixed(6),
                decimatedVsRefined:+C.Cartesian3.distance(coarse,refined.aggregate).toFixed(4)};
        })()`);
        log("h1", JSON.stringify(out.h1));

        // H2: precision delta (decimated pick vs refined aggregate) across many splat pixels.
        out.h2 = await wc.executeJavaScript(`(()=>{
            const C=window.Cesium,s=window.tilesetViewer.viewer.scene;
            const snap=window.tilesetViewer._rotationCenterSnap,src=snap._splatSource;
            const c=s.canvas,W=c.clientWidth,H=c.clientHeight,step=40;const deltas=[];
            for(let y=step;y<H;y+=step)for(let x=step;x<W;x+=step){
                const px=new C.Cartesian2(x,y);const coarse=src.query(s,px,28);if(!coarse)continue;
                const r=src.refine(s,coarse,12);if(!r)continue;
                deltas.push(C.Cartesian3.distance(coarse,r.aggregate));}
            deltas.sort((a,b)=>a-b);const n=deltas.length;
            const q=(p)=>n?+deltas[Math.min(n-1,Math.floor(p*n))].toFixed(4):null;
            return {samples:n,minDelta:q(0),medianDelta:q(0.5),maxDelta:q(0.999)};
        })()`);
        log("h2", JSON.stringify(out.h2));

        // H3: two chosen opaque centres, projected to pixels, re-picked; compare distances.
        out.h3 = await wc.executeJavaScript(`(()=>{
            const C=window.Cesium,s=window.tilesetViewer.viewer.scene;
            const snap=window.tilesetViewer._rotationCenterSnap;
            const t=window.tilesetViewer._leftTileset,gsp=t.gaussianSplatPrimitive;
            const pos=gsp._positions,colors=gsp._colors,rt=gsp._rootTransform,n=gsp._numSplats;
            const scale=(colors instanceof Uint8Array||colors instanceof Uint8ClampedArray)?1/255:1;
            const lp=new C.Cartesian3(),wp=new C.Cartesian3();
            // Collect on-screen opaque centres; take two well-separated ones.
            const cand=[];const stepI=Math.max(1,Math.ceil(n/4000));
            for(let i=0;i<n;i+=stepI){if(colors&&colors[i*4+3]*scale<0.15)continue;
                lp.x=pos[i*3];lp.y=pos[i*3+1];lp.z=pos[i*3+2];C.Matrix4.multiplyByPoint(rt,lp,wp);
                const scr=s.cartesianToCanvasCoordinates(wp,new C.Cartesian2());
                if(scr)cand.push({w:{x:wp.x,y:wp.y,z:wp.z},x:scr.x,y:scr.y});}
            if(cand.length<2)return {ok:false,reason:'few on-screen centres',cand:cand.length};
            let A=cand[0],B=cand[0],bd=-1;
            for(let i=0;i<cand.length;i++)for(let j=i+1;j<cand.length;j+=97){
                const d=(cand[i].x-cand[j].x)**2+(cand[i].y-cand[j].y)**2;if(d>bd){bd=d;A=cand[i];B=cand[j];}}
            const trueDist=C.Cartesian3.distance(new C.Cartesian3(A.w.x,A.w.y,A.w.z),new C.Cartesian3(B.w.x,B.w.y,B.w.z));
            const ma=snap.resolveMeasurement(new C.Cartesian2(Math.round(A.x),Math.round(A.y)));
            const mb=snap.resolveMeasurement(new C.Cartesian2(Math.round(B.x),Math.round(B.y)));
            if(!ma||!mb)return {ok:false,reason:'resolveMeasurement miss'};
            const measured=C.Cartesian3.distance(ma.point,mb.point);
            const sigma=Math.sqrt(ma.spread*ma.spread+mb.spread*mb.spread);
            return {ok:true,trueDist:+trueDist.toFixed(4),measured:+measured.toFixed(4),
                sigma:+sigma.toFixed(4),err:+Math.abs(trueDist-measured).toFixed(4),
                withinSigma:Math.abs(trueDist-measured)<=Math.max(sigma,trueDist*0.02),
                pxA:{x:Math.round(A.x),y:Math.round(A.y)},pxB:{x:Math.round(B.x),y:Math.round(B.y)}};
        })()`);
        log("h3", JSON.stringify(out.h3));

        const rect = await wc.executeJavaScript(`(()=>{const c=window.tilesetViewer.viewer.scene.canvas;const r=c.getBoundingClientRect();return{left:r.left,top:r.top};})()`);
        const dbg=wc.debugger; if(!dbg.isAttached())dbg.attach("1.3"); win.focus();
        const hp0 = out.diag.hitPixel;
        const sx=Math.round(hp0.x+rect.left), sy=Math.round(hp0.y+rect.top);

        // Gesture gating: tilt (right-drag) must refine the pivot; zoom (wheel) must not.
        // _refineCount only increments when a splat pivot is refined for spin/tilt.
        const refCount = ()=>wc.executeJavaScript(`window.tilesetViewer._rotationCenterSnap._refineCount`);
        // Right-drag = tilt.
        const beforeTilt=await refCount();
        await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mousePressed",x:sx,y:sy,button:"right",buttons:2,clickCount:1});
        await sleep(60);
        // Crosshair must now show on right-drag (tilt), not just left-drag.
        out.markerOnTilt=await wc.executeJavaScript(`window.tilesetViewer._rotationCenterSnap._markerEl.style.display==='block'`);
        for(let i=1;i<=8;i++){await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x:sx+i*4,y:sy+i*3,button:"right",buttons:2});await sleep(20);}
        await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseReleased",x:sx+32,y:sy+24,button:"right",buttons:0,clickCount:1});
        await sleep(60);
        const afterTilt=await refCount();
        // Wheel = zoom (no button down → gesture null → must not refine).
        const beforeZoom=await refCount();
        for(let i=0;i<10;i++){await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseWheel",x:sx,y:sy,deltaX:0,deltaY:-120});await sleep(25);}
        const afterZoom=await refCount();
        out.gating={tiltRefines:afterTilt-beforeTilt,zoomRefines:afterZoom-beforeZoom};
        log("gating", JSON.stringify(out.gating));

        // Overlay: activate MEASURE via the tool, drive two synthetic clicks, screenshot.
        await wc.executeJavaScript(`window.tilesetViewer._measureTool.activate()`);
        const clickAt = async (px,py)=>{
            const x=Math.round(px+rect.left),y=Math.round(py+rect.top);
            await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
            await sleep(40);
            await dbg.sendCommand("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
            await sleep(120);
        };
        const pA = out.h3.ok ? out.h3.pxA : out.diag.hitPixel;
        const pB = out.h3.ok ? out.h3.pxB : {x:out.diag.hitPixel.x+120,y:out.diag.hitPixel.y+60};
        await clickAt(pA.x,pA.y);
        await clickAt(pB.x,pB.y);
        await sleep(200);
        out.overlay = await wc.executeJavaScript(`(()=>{const mt=window.tilesetViewer._measureTool;
            return {aSet:!!mt._a,bSet:!!mt._b,svgVisible:mt._svg.style.display==='block',label:mt._label.textContent};})()`);
        log("overlay", JSON.stringify(out.overlay));
        try{const img=await wc.capturePage();fs.writeFileSync(path.join(__dirname,"traces","gs-measure-verify.png"),img.toPNG());}catch(e){}

        out.PASS = out.h1.ok && out.h1.nearestErr < 1e-3 &&
                   out.h2.samples > 0 &&
                   out.h3.ok && out.h3.withinSigma &&
                   out.gating.tiltRefines > 0 && out.gating.zoomRefines === 0 &&
                   out.markerOnTilt === true &&
                   out.overlay.aSet && out.overlay.bSet && out.overlay.svgVisible &&
                   out.errors.length===0;
        out.summary = `nearestErr=${out.h1.ok?out.h1.nearestErr:'n/a'} `+
            `delta(min/med/max)=${out.h2.minDelta}/${out.h2.medianDelta}/${out.h2.maxDelta} `+
            `H3 err=${out.h3.ok?out.h3.err:'n/a'} sigma=${out.h3.ok?out.h3.sigma:'n/a'} `+
            `gating(tilt/zoom refines)=${out.gating.tiltRefines}/${out.gating.zoomRefines} markerOnTilt=${out.markerOnTilt} `+
            `refineMs=${out.h1.ok?out.h1.refineMs:'n/a'} queryMs=${out.h1.ok?out.h1.lastQueryMs:'n/a'} `+
            `overlay=${out.overlay&&out.overlay.svgVisible} crash=${out.errors.length>0}`;
        log("RESULT", out.summary, out.PASS?"PASS":"FAIL");
        fs.writeFileSync(path.join(__dirname,"traces","gs-measure-verify.json"),JSON.stringify(out,null,2));
    }catch(e){console.error("[gsm] FAILED",e);out.fatal=String(e);
        try{fs.writeFileSync(path.join(__dirname,"traces","gs-measure-verify.json"),JSON.stringify(out,null,2));}catch(_){}}
    finally{await sleep(300);app.quit();}
});
