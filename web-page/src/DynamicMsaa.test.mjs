// ABOUTME: Headless unit test for DynamicMsaa.js. Run:
// ABOUTME:   node src/DynamicMsaa.test.mjs   (exits non-zero on failure)
//
// Drives the class with a fake scene and a fake clock, so it needs no GPU and no
// CesiumJS. The fake camera carries position/direction/up and raises preUpdate
// the way Scene.prototype.render does: on every animation frame, drawn or not.
// It proves the rules that the feature hinges on:
//   - a movement drops the samples to 1, and only while the feature is on;
//   - the stop restores the chosen count AND asks for the frame that shows it;
//   - the RENORMALIZATION DRIFT does not read as movement (the fault that broke
//     both earlier implementations, measured at ~3e-16 per frame);
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

// A fake scene with a controllable clock. One frame() is one animation frame,
// which is what CesiumJS gives preUpdate whether or not it draws.
function makeScene() {
    const preUpdate = makeEvent();

    return {
        msaaSamples: 1,
        renders: 0,
        time: 1000,
        camera: {
            position: {x: 0, y: 0, z: 1000},
            direction: {x: 0, y: 0, z: -1},
            up: {x: 0, y: 1, z: 0},
        },
        preUpdate,
        requestRender() { this.renders += 1; },

        // One animation frame, MS milliseconds after the previous one.
        frame(ms) { this.time += (ms === undefined ? 16 : ms); preUpdate.raiseEvent(); },

        // A real movement: a tenth of a degree of turn is far above the epsilon.
        turn(amount) { this.camera.direction.x += (amount === undefined ? 1e-3 : amount); },

        // The renormalization drift that CesiumJS applies with no user input.
        // Measured in the app at about 3e-16 per frame on a direction component.
        drift() { this.camera.direction.y += 3e-16; },
    };
}

function setup(targetSamples, enabled) {
    const scene = makeScene();
    const msaa = new DynamicMsaa({scene, now: () => scene.time});

    if (targetSamples !== undefined) msaa.setTargetSamples(targetSamples);
    if (enabled) msaa.setEnabled(true);

    return {scene, msaa};
}

// Runs frames until the quiet period has passed, so the stop is detected.
function rest(scene, ms) {
    const total = ms === undefined ? 400 : ms;
    for (let elapsed = 0; elapsed < total; elapsed += 16) scene.frame(16);
}

// --- 1. off: a movement changes nothing --------------------------------------
{
    const {scene} = setup(4, false);

    scene.turn();
    scene.frame();

    check("the feature off keeps the chosen count while moving", scene.msaaSamples === 4,
        `got ${scene.msaaSamples}`);
}

// --- 2. on: a movement drops to 1 and the stop restores ----------------------
{
    const {scene, msaa} = setup(4, true);

    scene.turn();
    scene.frame();

    check("a movement drops to 1 sample", scene.msaaSamples === 1, `got ${scene.msaaSamples}`);
    check("the logic reports the movement", msaa.moving === true);

    const rendersBefore = scene.renders;

    rest(scene);

    check("the stop restores the chosen count", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);
    check("the logic reports the stop", msaa.moving === false);
    check("the stop asks for the frame that shows it", scene.renders > rendersBefore);
}

// --- 3. THE REGRESSION: drift is not movement --------------------------------
// Both earlier implementations failed here. The first compared exactly on each
// drawn frame; the second leaned on camera.moveEnd, which CesiumJS never raises
// once the drift accumulates against its own clone. 600 frames is ten seconds.
{
    const {scene, msaa} = setup(4, true);

    scene.turn();
    scene.frame();

    check("drift test starts from a real movement", scene.msaaSamples === 1);

    rest(scene);

    check("the stop restores the count before the drift", scene.msaaSamples === 4);

    const transitionsAfterStop = msaa.transitions;

    for (let i = 0; i < 600; i++) {
        scene.drift();
        scene.frame();
    }

    check("the drift does not read as movement", msaa.moving === false);
    check("the drift keeps the chosen sample count", scene.msaaSamples === 4,
        `got ${scene.msaaSamples}`);
    check("the drift rebuilds no framebuffer", msaa.transitions === transitionsAfterStop,
        `${msaa.transitions - transitionsAfterStop} extra transitions`);
}

// --- 4. a real movement after a quiet spell is still caught -------------------
// The drift must not desensitise the check: the reference has to track it.
{
    const {scene, msaa} = setup(4, true);

    for (let i = 0; i < 600; i++) { scene.drift(); scene.frame(); }

    scene.turn();
    scene.frame();

    check("a real movement after a long quiet spell is caught", msaa.moving === true);
    check("and it drops the samples", scene.msaaSamples === 1, `got ${scene.msaaSamples}`);
}

// --- 5. "Off" never writes the property --------------------------------------
{
    const {scene, msaa} = setup(1, true);

    const before = msaa.transitions;

    scene.turn();
    scene.frame();

    check("1 sample stays 1 sample", scene.msaaSamples === 1);

    rest(scene);

    check("1 sample rebuilds no framebuffer", msaa.transitions === before,
        `${msaa.transitions - before} transitions`);
}

// --- 6. one gesture writes the property two times ----------------------------
{
    const {scene, msaa} = setup(4, true);

    const before = msaa.transitions;

    for (let i = 0; i < 30; i++) { scene.turn(); scene.frame(); }

    rest(scene);

    check("one gesture writes the property two times", msaa.transitions - before === 2,
        `got ${msaa.transitions - before}`);
    check("the gesture ends at the chosen sample count", scene.msaaSamples === 4);
}

// --- 7. a new choice during a movement waits for the stop --------------------
{
    const {scene, msaa} = setup(4, true);

    scene.turn();
    scene.frame();

    msaa.setTargetSamples(2);

    check("the new choice does not interrupt the movement", scene.msaaSamples === 1,
        `got ${scene.msaaSamples}`);

    rest(scene);

    check("the stop applies the new choice", scene.msaaSamples === 2, `got ${scene.msaaSamples}`);
}

// --- 8. the feature off during a movement restores at once -------------------
{
    const {scene, msaa} = setup(4, true);

    scene.turn();
    scene.frame();

    msaa.setEnabled(false);

    check("the feature off restores at once", scene.msaaSamples === 4, `got ${scene.msaaSamples}`);

    rest(scene);

    check("the stop after that keeps the chosen count", scene.msaaSamples === 4);
}

// --- 9. the feature on during a movement drops the samples -------------------
{
    const {scene, msaa} = setup(4, false);

    scene.turn();
    scene.frame();
    msaa.setEnabled(true);

    check("the feature on during a movement drops to 1 sample", scene.msaaSamples === 1,
        `got ${scene.msaaSamples}`);

    rest(scene);

    check("the stop after that restores the chosen count", scene.msaaSamples === 4);
}

// --- 10. the state callback feeds the indicators in the settings panel -------
{
    const scene = makeScene();
    const seen = [];
    const msaa = new DynamicMsaa({scene, now: () => scene.time, onChange: (s) => seen.push(s)});

    msaa.setTargetSamples(4);
    msaa.setEnabled(true);

    const afterSetup = seen.length;

    scene.turn();
    scene.frame();

    check("the callback reports the movement", seen.length > afterSetup && seen[seen.length - 1].moving === true);
    check("the callback reports 1 sample while moving", seen[seen.length - 1].samples === 1,
        `got ${seen[seen.length - 1].samples}`);

    rest(scene);

    check("the callback reports the stop", seen[seen.length - 1].moving === false);
    check("the callback reports the restored count", seen[seen.length - 1].samples === 4,
        `got ${seen[seen.length - 1].samples}`);
    check("state() agrees with the last callback",
        msaa.state().samples === seen[seen.length - 1].samples &&
        msaa.state().moving === seen[seen.length - 1].moving);
}

// --- 11. no callback is not an error -----------------------------------------
{
    const {scene} = setup(4, true);

    scene.turn();
    scene.frame();
    rest(scene);

    check("the class works without an onChange", scene.msaaSamples === 4);
}

// --- 12. a still camera never starts a movement ------------------------------
{
    const {scene, msaa} = setup(4, true);

    for (let i = 0; i < 120; i++) scene.frame();

    check("a still camera never starts a movement", msaa.moving === false);
    check("a still camera holds the chosen count", scene.msaaSamples === 4);
}

console.log(failures === 0 ? "\nall tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
