/*eslint-env node*/
/* eslint-disable no-console */
"use strict";

// Instrument for the dynamic multisampling feature. It reads the DRAWN PIXELS,
// not scene.msaaSamples, so it answers the question that the user asks: does
// the image really get smooth edges when the camera stops?
//
// It builds its own scene: one flat (unlit) white box on the #333333
// background, seen at an angle. Every pixel of that image is either 51 or 255
// unless something blends an edge, so a count of the in-between pixels is a
// direct measure of the antialiasing. It needs no tileset and no GPU: it draws
// on SwiftShader, which gives a WebGL2 context with multisampling.
//
// Run:  DISPLAY=:0 node_modules/.bin/electron tools/dynamic-msaa-probe.js
//   or: xvfb-run -a node_modules/.bin/electron tools/dynamic-msaa-probe.js
// Output: tools/traces/dynamic-msaa-probe.json
//
// It also reports which build of DynamicMsaa the bundle holds. web-page/app.js
// is gitignored and electron-forge does not build it, so a stale bundle is the
// first thing to rule out. Rebuild with: cd web-page && npx rollup -c

const {app, BrowserWindow} = require("electron");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");

// Longer than scene.cameraEventWaitTime (500 ms), which is how long CesiumJS
// waits before it raises camera.moveEnd.
const REST_MS = 2000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) { console.log("[probe]", ...a); }

// ANGLE on SwiftShader, so the check gives the same answer on a machine with a
// GPU and on one without. It still needs a display connection, because Electron
// starts GTK. Use the real display, or xvfb-run.
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

// Builds the test scene.
const SCENE_SOURCE = `(function () {
    const scene = window.tilesetViewer.viewer.scene;
    const centre = Cesium.Cartesian3.fromDegrees(-100.0, 40.0, 300000.0);
    const size = 200000.0;

    scene.primitives.add(new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
            geometry: Cesium.BoxGeometry.fromDimensions({
                vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                dimensions: new Cesium.Cartesian3(size, size, size),
            }),
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(centre),
            attributes: {color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.WHITE)},
        }),
        appearance: new Cesium.PerInstanceColorAppearance({flat: true, translucent: false}),
        asynchronous: false,
    }));

    // An angled view, so the box shows diagonal edges. Release the transform at
    // once, or the camera stays locked to the box.
    scene.camera.lookAt(centre, new Cesium.HeadingPitchRange(0.7, -0.45, 1200000.0));
    scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    scene.requestRender();
    return true;
})()`;

// Counts the blended pixels of one drawn frame.
const COUNTER_SOURCE = `(function () {
    const scene = window.tilesetViewer.viewer.scene;
    const gl = scene.canvas.getContext('webgl2');

    window.__countEdge = function () {
        return new Promise(function (resolve) {
            const remove = scene.postRender.addEventListener(function () {
                const w = gl.drawingBufferWidth;
                const h = gl.drawingBufferHeight;
                const buf = new Uint8Array(w * h * 4);

                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

                let blended = 0, white = 0, back = 0;

                for (let i = 0; i < buf.length; i += 4) {
                    const r = buf[i];
                    if (r > 240) white++;
                    else if (r < 70) back++;
                    else blended++;
                }

                remove();
                resolve({blended: blended, white: white, back: back, samples: scene.msaaSamples});
            });

            scene.requestRender();
        });
    };
    return true;
})()`;

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
        out.dynamicMsaaExists = await wc.executeJavaScript(`!!window.tilesetViewer.dynamicMsaa`);

        if (!out.dynamicMsaaExists) {
            log("no DynamicMsaa on the viewer. Either the bundle is old, or the context reports no multisampling support.");
        }

        // Which build is in web-page/app.js? The first build compared the camera
        // vectors on each drawn frame and kept the result in _state, with a
        // timer in _timer. The build that works follows camera.moveStart and
        // camera.moveEnd and has neither field.
        out.bundleSignal = await wc.executeJavaScript(`(()=>{
            const d = window.tilesetViewer.dynamicMsaa;
            if (!d) return 'no DynamicMsaa';
            if (d._state !== undefined || d._timer !== undefined) return 'per-frame compare (STALE BUNDLE - rebuild it)';
            return 'camera moveStart/moveEnd (current)';
        })()`);
        log("bundle signal:", out.bundleSignal);

        await wc.executeJavaScript(SCENE_SOURCE);
        await sleep(2500);
        await wc.executeJavaScript(COUNTER_SOURCE);

        async function measure(label) {
            const r = await wc.executeJavaScript(`window.__countEdge()`);
            log(label.padEnd(36), "blendedPixels", String(r.blended).padStart(6),
                "white", String(r.white).padStart(7), "msaaSamples", r.samples);
            return r;
        }

        // A. multisampling Off, feature off. The reference for a hard edge.
        await wc.executeJavaScript(`jQuery('#msaa-dynamic-checkbox').prop('checked', false).trigger('change');
            jQuery('#msaa-samples-select').val('1').trigger('change'); true`);
        await sleep(600);
        out.msaaOff = await measure("MSAA Off, feature off");

        // B. multisampling Full, feature off. The reference for a smooth edge.
        await wc.executeJavaScript(`jQuery('#msaa-samples-select').val('4').trigger('change'); true`);
        await sleep(600);
        out.msaaFull = await measure("MSAA Full, feature off");

        // C. the feature on, camera at rest.
        await wc.executeJavaScript(`jQuery('#msaa-dynamic-checkbox').prop('checked', true).trigger('change'); true`);
        await sleep(REST_MS);
        out.featureOnAtRest = await measure("MSAA Full, feature on, at rest");

        // D. the feature on, camera moving.
        await wc.executeJavaScript(`window.tilesetViewer.viewer.camera.rotateRight(0.0004); true`);
        out.featureOnMoving = await measure("MSAA Full, feature on, moving");

        // E. the feature on, camera stopped again.
        await sleep(REST_MS);
        out.featureOnStopped = await measure("MSAA Full, feature on, stopped");

        const hard = out.msaaOff.blended;
        const smooth = out.msaaFull.blended;
        const near = (a, b) => Math.abs(a - b) < Math.max(60, b * 0.3);

        out.checks = {
            multisamplingReallySmoothsEdges: smooth > hard * 2 || smooth > hard + 200,
            atRestIsSmooth: near(out.featureOnAtRest.blended, smooth),
            movingIsHard: near(out.featureOnMoving.blended, hard),
            stoppedIsSmooth: near(out.featureOnStopped.blended, smooth),
        };
        out.PASS = Object.values(out.checks).every(Boolean);

        log("checks", JSON.stringify(out.checks));
        log(out.PASS ? "PASS" : "FAIL");

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
