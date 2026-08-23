// ABOUTME: One-off test runner for formatPerfWindow (no test framework in repo).
// ABOUTME: Run with `node src/formatPerfWindow.test.mjs`; exits non-zero on failure.

// initSettingsPopup.js imports CesiumJsInc.js, which reads the global Cesium
// object at load time. Node has no Cesium, so a proxy stands in for it.
globalThis.Cesium = new Proxy({}, {get: () => function () {}});

const {formatPerfWindow, formatGpuWindow, createGpuTimer} = await import("./initSettingsPopup.js");

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

// --- GPU value format ---------------------------------------------------

check("no extension reads not available", formatGpuWindow(30, 4.2, false) === "not available");
check("no frame reads idle", formatGpuWindow(0, 4.2, true) === "idle");
check("no result yet reads measuring", formatGpuWindow(30, null, true) === "measuring");
check("a result reads milliseconds", formatGpuWindow(30, 4.25, true) === "4.3 ms");

// --- GPU timer ----------------------------------------------------------

// Minimal stand-in for a WebGL2 context with the timer-query extension.
// Each query holds a result in nanoseconds and a ready flag that the test sets.
function fakeGl(hasExtension) {
    const gl = {
        QUERY_RESULT_AVAILABLE: "available",
        QUERY_RESULT: "result",
        disjoint: 0,
        created: [],
        deleted: [],
        active: null,
        createQuery() {
            const q = {ready: false, ns: 0};
            gl.created.push(q);
            return q;
        },
        beginQuery(target, query) {
            if (gl.active) throw new Error("a query is already active");
            gl.active = query;
        },
        endQuery() {
            if (!gl.active) throw new Error("no query is active");
            gl.active = null;
        },
        getQueryParameter(query, name) {
            return name === gl.QUERY_RESULT_AVAILABLE ? query.ready : query.ns;
        },
        getParameter() { return gl.disjoint; },
        deleteQuery(query) { gl.deleted.push(query); },
        getExtension(name) {
            if (!hasExtension || name !== "EXT_disjoint_timer_query_webgl2") return null;
            return {TIME_ELAPSED_EXT: "time", GPU_DISJOINT_EXT: "disjoint"};
        },
    };
    return gl;
}

function fakeScene(gl) {
    return {canvas: {getContext: (type) => (type === "webgl2" ? gl : null)}};
}

check("no extension gives no timer", createGpuTimer(fakeScene(fakeGl(false))) === null);
check("no webgl2 context gives no timer",
    createGpuTimer({canvas: {getContext: () => null}}) === null);

let gl = fakeGl(true);
let timer = createGpuTimer(fakeScene(gl));

// Rule 1: only one query may be active, so a second begin must do nothing.
timer.begin();
timer.begin();
check("a second begin starts no second query", gl.created.length === 1);
timer.end();
timer.end();
check("a second end closes no query", gl.created.length === 1);

// A query that the GPU has not finished stays pending.
check("an unfinished query gives no value", timer.collect() === null);
check("an unfinished query is not deleted", gl.deleted.length === 0);

// Two finished frames: 4 ms and 6 ms give a mean of 5 ms.
gl.created[0].ns = 4e6;
gl.created[0].ready = true;
timer.begin();
timer.end();
gl.created[1].ns = 6e6;
gl.created[1].ready = true;
check("the mean of 4 ms and 6 ms is 5 ms", timer.collect() === 5);
check("finished queries are deleted", gl.deleted.length === 2);
check("a second collect gives no value", timer.collect() === null);

// Rule 2: a disjoint period makes every result in it wrong.
gl = fakeGl(true);
timer = createGpuTimer(fakeScene(gl));
timer.begin();
timer.end();
gl.created[0].ns = 9e6;
gl.created[0].ready = true;
gl.disjoint = 1;
check("a disjoint result is thrown away", timer.collect() === null);
check("a disjoint query is still deleted", gl.deleted.length === 1);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
