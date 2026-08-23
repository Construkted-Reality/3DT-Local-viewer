// ABOUTME: One-off test runner for formatPerfWindow (no test framework in repo).
// ABOUTME: Run with `node src/formatPerfWindow.test.mjs`; exits non-zero on failure.

// initSettingsPopup.js imports CesiumJsInc.js, which reads the global Cesium
// object at load time. Node has no Cesium, so a proxy stands in for it.
globalThis.Cesium = new Proxy({}, {get: () => function () {}});

const {formatPerfWindow} = await import("./initSettingsPopup.js");

let failures = 0;
function check(name, condition) {
    if (condition) {
        console.log(`ok   - ${name}`);
    } else {
        console.error(`FAIL - ${name}`);
        failures++;
    }
}

// A window with no drawn frame is the idle state of requestRenderMode.
let out = formatPerfWindow(0, 0, 500);
check("no frame reads idle", out.fps === "idle" && out.frameMs === "idle");

// A stopped or backwards timer must not produce Infinity or NaN.
out = formatPerfWindow(30, 100, 0);
check("zero elapsed time reads idle", out.fps === "idle" && out.frameMs === "idle");

// 30 frames in 500 ms is 60 frames per second.
out = formatPerfWindow(30, 150, 500);
check("30 frames in 500 ms is 60 fps", out.fps === "60 fps");
check("150 ms over 30 frames is 5.0 ms", out.frameMs === "5.0 ms");

// 8 frames in 1000 ms is 8 frames per second, and the mean frame time is 12.5 ms.
out = formatPerfWindow(8, 100, 1000);
check("8 frames in 1000 ms is 8 fps", out.fps === "8 fps");
check("100 ms over 8 frames is 12.5 ms", out.frameMs === "12.5 ms");

// The frame rate rounds to a whole number, the frame time keeps one decimal.
out = formatPerfWindow(7, 40, 480);
check("frame rate rounds to a whole number", out.fps === "15 fps");
check("frame time keeps one decimal", out.frameMs === "5.7 ms");

// A slow scene must still read as a number, not as idle.
out = formatPerfWindow(1, 240, 500);
check("one slow frame is not idle", out.fps === "2 fps" && out.frameMs === "240.0 ms");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
