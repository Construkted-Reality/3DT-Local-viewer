// ABOUTME: Headless unit test for DynamicMsaa.js. Run:
// ABOUTME:   node src/DynamicMsaa.test.mjs   (exits non-zero on failure)
//
// Drives the class with a fake scene, so it needs no GPU and no CesiumJS. The
// fake camera raises moveStart and moveEnd the way View.checkForCameraUpdates
// does. It proves the rules that the feature hinges on:
//   - a movement drops the samples to 1, and only while the feature is on;
//   - the stop restores the chosen count AND asks for the frame that shows it;
//   - "Off" (1 sample) never writes the property, so it never rebuilds the
//     framebuffer;
//   - one gesture writes the property two times, whatever its length;
//   - a change of the chosen count during a movement waits for the stop.

import {DynamicMsaa} from "./DynamicMsaa.js";

let failures = 0;
function check(name, cond, extra) {
    if (cond) console.log(`ok   - ${name}`);
    else { console.error(`FAIL - ${name}${extra ? " :: " + extra : ""}`); failures++; }
}

function makeEvent() {
    const listeners = [];

    return {
        addEventListener: (fn) => listeners.push(fn),
        raiseEvent: () => { for (const fn of listeners) fn(); },
    };
}

// A fake scene. CesiumJS raises moveStart one time for each burst of movement
// and moveEnd one time when the camera holds still, so the fake follows that
// rule instead of raising an event for each frame.
function makeScene() {
    const moveStart = makeEvent();
    const moveEnd = makeEvent();

    return {
        msaaSamples: 1,
        renders: 0,
        moving: false,
        camera: {moveStart, moveEnd},
        requestRender() { this.renders += 1; },
        startMove() { if (!this.moving) { this.moving = true; moveStart.raiseEvent(); } },
        endMove() { if (this.moving) { this.moving = false; moveEnd.raiseEvent(); } },
    };
}

function setup(targetSamples, enabled) {
    const scene = makeScene();
    const msaa = new DynamicMsaa({scene});

    if (targetSamples !== undefined) msaa.setTargetSamples(targetSamples);
    if (enabled) msaa.setEnabled(true);

    return {scene, msaa};
}

// --- 1. off: a movement changes nothing --------------------------------------
{
    const {scene, msaa} = setup(4, false);

    scene.startMove();

    check("feature off keeps the chosen sample count", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);

    scene.endMove();

    check("feature off still keeps the chosen sample count", scene.msaaSamples === 4);
    check("feature off reports no movement", msaa.moving === false);
}

// --- 2. on: move drops to 1, stop restores and asks for a frame ---------------
{
    const {scene, msaa} = setup(4, true);
    const rendersBeforeMove = scene.renders;

    scene.startMove();

    check("a movement drops the scene to 1 sample", scene.msaaSamples === 1, `got ${scene.msaaSamples}`);
    check("a movement asks for no frame", scene.renders === rendersBeforeMove);

    scene.endMove();

    check("the stop restores the chosen sample count", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);
    check("the stop asks for a frame", scene.renders > rendersBeforeMove);
    check("the stop reports no movement", msaa.moving === false);
}

// --- 3. "Off" never touches the property -------------------------------------
{
    const {scene, msaa} = setup(1, true);
    const transitionsAtStart = msaa.transitions;

    scene.startMove();
    scene.endMove();
    scene.startMove();
    scene.endMove();

    check("1 sample stays 1 sample", scene.msaaSamples === 1);
    check("1 sample rebuilds no framebuffer", msaa.transitions === transitionsAtStart,
        `${msaa.transitions - transitionsAtStart} writes`);
}

// --- 4. one gesture costs two transitions ------------------------------------
{
    const {scene, msaa} = setup(4, true);
    const transitionsAtStart = msaa.transitions;

    scene.startMove();
    scene.startMove(); // CesiumJS raises moveStart one time, but a repeat is harmless
    scene.endMove();

    check("one gesture writes the property two times", msaa.transitions - transitionsAtStart === 2,
        `${msaa.transitions - transitionsAtStart} writes`);
    check("the gesture ends at the chosen sample count", scene.msaaSamples === 4);
}

// --- 5. a new choice during a movement waits for the stop ---------------------
{
    const {scene, msaa} = setup(2, true);

    scene.startMove();
    msaa.setTargetSamples(4);

    check("the new choice does not interrupt the movement", scene.msaaSamples === 1, `got ${scene.msaaSamples}`);

    scene.endMove();

    check("the stop applies the new choice", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);
}

// --- 6. the feature off during a movement restores at once --------------------
{
    const {scene, msaa} = setup(4, true);

    scene.startMove();
    msaa.setEnabled(false);

    check("the feature off restores at once", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);

    scene.endMove();

    check("the stop after that keeps the chosen count", scene.msaaSamples === 4);
}

// --- 7. the feature on again during a movement drops the samples --------------
{
    const {scene, msaa} = setup(4, false);

    scene.startMove();
    msaa.setEnabled(true);

    check("the feature on during a movement drops to 1 sample", scene.msaaSamples === 1, `got ${scene.msaaSamples}`);

    scene.endMove();

    check("the stop after that restores the chosen count", scene.msaaSamples === 4);
}

console.log(failures === 0 ? "\nall tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
