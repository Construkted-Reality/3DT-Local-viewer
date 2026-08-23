// ABOUTME: Multisampling that follows the camera. Off while the camera moves, on when it stops.
// ABOUTME: Pure logic, no Cesium import, so DynamicMsaa.test.mjs can drive it with a fake scene.
//
// WHY THIS WORKS
// The scene runs in requestRenderMode (see CLAUDE.md), so it draws a frame only
// when something asks for one. An idle scene draws nothing, and multisampling
// costs GPU time only on a drawn frame. Almost every drawn frame is therefore a
// frame that the camera moves through, which is where a low frame rate is most
// visible. This class spends the sample budget where it is free: 1 sample while
// the camera moves, the chosen sample count after the camera stops.
//
// HOW IT KNOWS THAT THE CAMERA MOVES
// It compares the camera with a reference of its own on every animation frame,
// at a TOLERANT epsilon, and calls the camera stopped after QUIET_MS with no
// change beyond that epsilon.
//
// It does NOT use camera.moveStart and camera.moveEnd. That was the second
// implementation and it failed against a real tileset. Measured in the app,
// with nobody touching the camera:
//
//     camera vs the previous frame          no difference, 60 frames of 60
//     camera vs CesiumJS's own clone        direction differs, 5 frames of 60
//     CesiumJS state                        startFired=true since=50ms wait=500ms
//
// CesiumJS renormalizes the camera vectors on every frame, which moves their
// last bits by about 3e-16 with no input. Between frames that is invisible, but
// View.checkForCameraUpdates compares against a clone that it re-takes only when
// it finds a difference, so the drift ACCUMULATES against that clone and crosses
// its relative epsilon of 1e-15 about every twelfth frame. Each crossing pushes
// _cameraMovedTime forward, so the 500 ms of quiet that moveEnd needs never
// arrives: moveEnd is unreachable, the sample count never comes back, and
// cameraChanged forces a drawn frame every tick (a busy GPU on a still scene).
//
// The first implementation compared the camera on each drawn frame with an EXACT
// comparison, which reads the same drift as movement. Both failures come from
// the same drift; the cure is the epsilon, not the source of the signal.
//
// CHOOSING THE EPSILON
// The drift is about 3e-16 per frame on a component of a unit vector, so it
// accumulates to roughly 1e-14 over a quiet period. The smallest camera
// movement a user can make changes a direction component by about 1e-5. Nine
// orders of magnitude separate them, so 1e-9 ignores the drift and still catches
// any real movement.
//
// WHY preUpdate AND NOT A DRAWN FRAME
// preUpdate runs on every animation frame, before CesiumJS decides whether to
// draw (see CLAUDE.md). A still scene draws nothing, so a check on a drawn frame
// would never see the camera stop. Running before the frame is built also means
// the first frame of a movement already draws at 1 sample. The check compares a
// few numbers and allocates nothing, which is what that path allows.
//
// CAUTION: a write to scene.msaaSamples makes CesiumJS destroy and rebuild the
// scene framebuffer on the next drawn frame (FramebufferManager.isDirty ->
// destroy -> new Texture + new Renderbuffer at the full canvas size). One
// transition therefore costs one allocation. One gesture costs two.
// tools/dynamic-msaa-verify.js measures the real cost of a transition.

// Ignores the renormalization drift, catches every real movement. See above.
const MOVE_EPSILON = 1e-9;

// How long the camera holds still before the sharp image comes back.
const QUIET_MS = 250;

function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;

    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function magnitude(v) {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function copyInto(source, target) {
    target.x = source.x;
    target.y = source.y;
    target.z = source.z;

    return target;
}

class DynamicMsaa {
    // options.scene     the Cesium scene. It needs msaaSamples, requestRender,
    //                   a camera with position/direction/up, and preUpdate.
    // options.onChange  optional. Called with state() after every change of
    //                   the state. Nothing in the app uses it; it is there for
    //                   the harnesses in tools/ and for a live read-out while
    //                   this feature is being worked on.
    // options.quietMs   optional. The still time that restores the samples.
    // options.now       optional. A clock, for the test.
    constructor(options) {
        const scene = options.scene;

        this._scene = scene;
        this._enabled = false;
        this._targetSamples = scene.msaaSamples;
        this._moving = false;
        this._onChange = options.onChange;
        this._quietMs = options.quietMs !== undefined ? options.quietMs : QUIET_MS;
        this._now = options.now || (() => Date.now());

        // Instrumentation for tools/dynamic-msaa-verify.js.
        this._transitions = 0;

        // The camera that the last real movement left behind. Everything within
        // MOVE_EPSILON of this is the same camera.
        const camera = scene.camera;

        this._reference = {
            position: copyInto(camera.position, {}),
            direction: copyInto(camera.direction, {}),
            up: copyInto(camera.up, {}),
        };

        this._lastChange = this._now();

        scene.preUpdate.addEventListener(() => this._check());
    }

    // Position is compared relative to its own size, the way CesiumJS does it,
    // so the same epsilon works close to the ground and far out in space.
    // Direction and up are unit vectors, so they compare absolutely.
    _cameraMoved(camera) {
        const reference = this._reference;
        const scale = Math.max(1, magnitude(camera.position));

        return distance(camera.position, reference.position) / scale > MOVE_EPSILON ||
            distance(camera.direction, reference.direction) > MOVE_EPSILON ||
            distance(camera.up, reference.up) > MOVE_EPSILON;
    }

    _check() {
        const camera = this._scene.camera;
        const now = this._now();

        if (this._cameraMoved(camera)) {
            copyInto(camera.position, this._reference.position);
            copyInto(camera.direction, this._reference.direction);
            copyInto(camera.up, this._reference.up);

            this._lastChange = now;

            // The movement draws its own frames, so this path asks for none.
            if (!this._moving) {
                this._moving = true;
                this._apply();
                this._notify();
            }

            return;
        }

        // The scene is idle when the camera stops, so nothing else asks for the
        // frame that shows the smooth edges.
        if (this._moving && now - this._lastChange >= this._quietMs) {
            this._moving = false;
            this._apply();
            this._scene.requestRender();
            this._notify();
        }
    }

    // What the logic believes right now, plus the sample count that the scene
    // really holds. The two disagreeing is the signature of a framebuffer that
    // ignores the property, so the harnesses in tools/ read both.
    state() {
        return {
            moving: this._moving,
            enabled: this._enabled,
            targetSamples: this._targetSamples,
            samples: this._scene.msaaSamples,
            transitions: this._transitions,
        };
    }

    _notify() {
        if (this._onChange)
            this._onChange(this.state());
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
        this._apply();
        this._scene.requestRender();
        this._notify();
    }

    // The sample count that the user chose in the settings panel. A change
    // while the camera moves waits for the stop.
    setTargetSamples(samples) {
        this._targetSamples = samples;
        this._apply();
        this._scene.requestRender();
        this._notify();
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

export {DynamicMsaa, MOVE_EPSILON, QUIET_MS}
