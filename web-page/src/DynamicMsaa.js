// ABOUTME: Multisampling that follows the camera. Off while the camera moves, on when it stops.
// ABOUTME: Pure logic, no Cesium import, so DynamicMsaa.test.mjs can drive it with a fake scene.
//
// WHY THIS WORKS
// The scene runs in requestRenderMode (see CLAUDE.md), so it draws a frame only
// when something asks for one. An idle scene draws nothing, and multisampling
// costs GPU time only on a drawn frame. Almost every drawn frame is therefore a
// frame that the camera moves through, which is where a low frame rate is most
// visible. This class spends the sample budget where it is free: 1 sample while
// the camera moves, the chosen sample count after the camera holds still.
//
// CAUTION: a write to scene.msaaSamples makes CesiumJS destroy and rebuild the
// scene framebuffer on the next drawn frame (FramebufferManager.isDirty ->
// destroy -> new Texture + new Renderbuffer at the full canvas size). One
// transition therefore costs one allocation. Two rules keep that cost small:
//   1. IDLE_MS holds the restore back, so a burst of wheel events pays for one
//      transition and not for twenty.
//   2. _apply writes the property only when the value really changes.
// tools/dynamic-msaa-verify.js measures the real cost of a transition.

// How long the camera holds still before the samples come back, in milliseconds.
const IDLE_MS = 250;

// The nine numbers that say where the camera is and where it points. A change
// in any of them is a camera movement. The up vector is in the list because a
// roll changes it and leaves the other two the same.
function readCamera(camera, out) {
    const position = camera.position;
    const direction = camera.direction;
    const up = camera.up;
    let changed = false;

    const next = [
        position.x, position.y, position.z,
        direction.x, direction.y, direction.z,
        up.x, up.y, up.z,
    ];

    for (let i = 0; i < 9; ++i) {
        if (out[i] !== next[i]) {
            out[i] = next[i];
            changed = true;
        }
    }

    return changed;
}

class DynamicMsaa {
    // options.scene    the Cesium scene (needs msaaSamples, camera, preRender, requestRender)
    // options.idleMs   optional override of the still time before the restore
    // options.timers   optional {setTimeout, clearTimeout} for the unit test
    constructor(options) {
        const scene = options.scene;

        this._scene = scene;
        this._idleMs = options.idleMs === undefined ? IDLE_MS : options.idleMs;
        this._timers = options.timers || {setTimeout: setTimeout, clearTimeout: clearTimeout};

        this._enabled = false;
        this._targetSamples = scene.msaaSamples;
        this._moving = false;
        this._timer = null;
        this._state = new Float64Array(9);
        this._started = false;

        // Instrumentation for tools/dynamic-msaa-verify.js.
        this._transitions = 0;

        // preRender runs before CesiumJS builds the frame, and only for a frame
        // that it really draws. A write here reaches the framebuffer update of
        // the same frame, so the first moved frame already draws at 1 sample.
        scene.preRender.addEventListener(() => this._onFrame());
    }

    // The camera moves only while frames are drawn, so the drawn frame is the
    // right place to watch it. The stop is the absence of a frame, which no
    // event reports, so a timer finds it.
    _onFrame() {
        const changed = readCamera(this._scene.camera, this._state);

        // The first frame only fills the state. There is nothing to compare it
        // with yet.
        if (!this._started) {
            this._started = true;
            return;
        }

        if (!changed || !this._enabled || this._targetSamples <= 1)
            return;

        this._moving = true;
        this._apply();
        this._restartIdleTimer();
    }

    _restartIdleTimer() {
        this._cancelIdleTimer();

        this._timer = this._timers.setTimeout(() => {
            this._timer = null;
            this._moving = false;
            this._apply();

            // The scene is idle at this point, so nothing else asks for the
            // frame that shows the smooth edges.
            this._scene.requestRender();
        }, this._idleMs);
    }

    _cancelIdleTimer() {
        if (this._timer !== null) {
            this._timers.clearTimeout(this._timer);
            this._timer = null;
        }
    }

    _apply() {
        const wanted = this._enabled && this._moving ? 1 : this._targetSamples;

        if (this._scene.msaaSamples === wanted)
            return;

        this._scene.msaaSamples = wanted;
        this._transitions += 1;
    }

    // Turns the dynamic behaviour on or off. Off restores the chosen sample
    // count at once.
    setEnabled(enabled) {
        this._enabled = enabled;

        if (!enabled) {
            this._cancelIdleTimer();
            this._moving = false;
        }

        this._apply();
        this._scene.requestRender();
    }

    // The sample count that the user chose in the settings panel. A change
    // while the camera moves waits for the stop.
    setTargetSamples(samples) {
        this._targetSamples = samples;
        this._apply();
        this._scene.requestRender();
    }

    get enabled() {
        return this._enabled;
    }

    get targetSamples() {
        return this._targetSamples;
    }

    get moving() {
        return this._moving;
    }

    get transitions() {
        return this._transitions;
    }
}

export {DynamicMsaa, readCamera, IDLE_MS}
