// ABOUTME: Headless unit test for DynamicMsaa.js. Run:
// ABOUTME:   node src/DynamicMsaa.test.mjs   (exits non-zero on failure)
//
// Drives the class with a fake scene and a fake timer, so it needs no GPU and
// no CesiumJS. It proves the five rules that the feature hinges on:
//   - a movement drops the samples to 1, and only while the feature is on;
//   - the stop restores the chosen count AND asks for the frame that shows it;
//   - "Off" (1 sample) never writes the property, so it never rebuilds the
//     framebuffer;
//   - a burst of movement pays for one transition, not one per frame;
//   - a change of the chosen count during a movement waits for the stop.

import {DynamicMsaa} from "./DynamicMsaa.js";

let failures = 0;
function check(name, cond, extra) {
    if (cond) console.log(`ok   - ${name}`);
    else { console.error(`FAIL - ${name}${extra ? " :: " + extra : ""}`); failures++; }
}

// A fake scene. frame() raises preRender the way a drawn frame does.
function makeScene() {
    const listeners = [];

    return {
        msaaSamples: 1,
        renders: 0,
        camera: {
            position: {x: 0, y: 0, z: 0},
            direction: {x: 0, y: 0, z: -1},
            up: {x: 0, y: 1, z: 0},
        },
        preRender: {addEventListener: (fn) => listeners.push(fn)},
        requestRender() { this.renders += 1; },
        frame() { for (const fn of listeners) fn(); },
        move(dx) { this.camera.position.x += dx; },
    };
}

// A fake timer. runPending() fires the callback the way the clock does.
function makeTimers() {
    let next = 1;
    const pending = new Map();

    return {
        setTimeout: (fn) => { const id = next++; pending.set(id, fn); return id; },
        clearTimeout: (id) => { pending.delete(id); },
        count: () => pending.size,
        runPending() {
            const fns = Array.from(pending.values());
            pending.clear();
            for (const fn of fns) fn();
        },
    };
}

function setup(targetSamples, enabled) {
    const scene = makeScene();
    const timers = makeTimers();
    const msaa = new DynamicMsaa({scene, timers, idleMs: 250});

    scene.frame(); // the first frame only records the camera state

    if (targetSamples !== undefined) msaa.setTargetSamples(targetSamples);
    if (enabled) msaa.setEnabled(true);

    return {scene, timers, msaa};
}

// --- 1. off: a movement changes nothing --------------------------------------
{
    const {scene, timers, msaa} = setup(4, false);

    scene.move(10);
    scene.frame();

    check("feature off keeps the chosen sample count", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);
    check("feature off starts no timer", timers.count() === 0);
    check("feature off reports no movement", msaa.moving === false);
}

// --- 2. on: move drops to 1, stop restores and asks for a frame ---------------
{
    const {scene, timers, msaa} = setup(4, true);
    const rendersBeforeMove = scene.renders;

    scene.move(10);
    scene.frame();

    check("a movement drops the scene to 1 sample", scene.msaaSamples === 1, `got ${scene.msaaSamples}`);
    check("a movement starts the idle timer", timers.count() === 1);

    timers.runPending();

    check("the stop restores the chosen sample count", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);
    check("the stop asks for a frame", scene.renders > rendersBeforeMove);
    check("the stop reports no movement", msaa.moving === false);
}

// --- 3. "Off" never touches the property -------------------------------------
{
    const {scene, msaa} = setup(1, true);
    const transitionsAtStart = msaa.transitions;

    scene.move(10);
    scene.frame();
    scene.move(10);
    scene.frame();

    check("1 sample stays 1 sample", scene.msaaSamples === 1);
    check("1 sample rebuilds no framebuffer", msaa.transitions === transitionsAtStart,
        `${msaa.transitions - transitionsAtStart} writes`);
}

// --- 4. a burst of movement pays for one transition ---------------------------
{
    const {scene, timers, msaa} = setup(4, true);
    const transitionsAtStart = msaa.transitions;

    for (let i = 0; i < 30; ++i) {
        scene.move(1);
        scene.frame();
        check(`frame ${i} keeps 1 sample`, scene.msaaSamples === 1);
    }

    check("30 moved frames write the property one time", msaa.transitions - transitionsAtStart === 1,
        `${msaa.transitions - transitionsAtStart} writes`);
    check("30 moved frames leave one timer", timers.count() === 1);

    timers.runPending();

    check("the burst restores the chosen count one time", msaa.transitions - transitionsAtStart === 2);
}

// --- 5. a still frame does not restart the timer ------------------------------
{
    const {scene, timers} = setup(4, true);

    scene.move(10);
    scene.frame();
    timers.runPending();

    scene.frame(); // a tile streams in, the camera holds still

    check("a still frame keeps the chosen sample count", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);
    check("a still frame starts no timer", timers.count() === 0);
}

// --- 6. a new choice during a movement waits for the stop ---------------------
{
    const {scene, timers, msaa} = setup(2, true);

    scene.move(10);
    scene.frame();

    msaa.setTargetSamples(4);

    check("the new choice does not interrupt the movement", scene.msaaSamples === 1, `got ${scene.msaaSamples}`);

    timers.runPending();

    check("the stop applies the new choice", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);
}

// --- 7. the feature off during a movement restores at once --------------------
{
    const {scene, timers, msaa} = setup(4, true);

    scene.move(10);
    scene.frame();
    msaa.setEnabled(false);

    check("the feature off restores at once", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);
    check("the feature off cancels the timer", timers.count() === 0);
}

// --- 8. the default timers call the global function, not a method of an object
// A browser throws "TypeError: Illegal invocation" when an object other than
// the window calls window.setTimeout. Node does not check the receiver, so this
// test checks it here: it replaces the global with a strict-mode function that
// records its receiver. A plain call leaves the receiver undefined.
{
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let receiver = "not called";

    globalThis.setTimeout = function (fn, ms) { receiver = this; return 1; };
    globalThis.clearTimeout = function () {};

    try {
        const scene = makeScene();
        const msaa = new DynamicMsaa({scene}); // no timers, so the defaults run

        scene.frame();
        msaa.setTargetSamples(4);
        msaa.setEnabled(true);
        scene.move(10);
        scene.frame();

        check("the default timer calls the global setTimeout plainly",
            receiver === undefined || receiver === globalThis, `receiver was ${typeof receiver}`);
    } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
    }
}

console.log(failures === 0 ? "\nall tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
