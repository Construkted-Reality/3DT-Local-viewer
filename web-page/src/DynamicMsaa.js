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
// CesiumJS answers that question itself. On every animation frame, before it
// decides to draw, View.checkForCameraUpdates compares the camera with a clone
// of the last known camera. It raises camera.moveStart on the first difference
// and camera.moveEnd when the camera holds still for scene.cameraEventWaitTime
// (500 ms). Both events run on every animation frame, not only on a drawn one,
// so moveEnd arrives even though a still scene draws nothing.
//
// CAUTION: do NOT replace those two events with a comparison of camera.position
// and camera.direction on each drawn frame. CesiumJS renormalizes the camera
// vectors every frame, which changes their last bits with no input from the
// user. An exact comparison reads that drift as movement and the sample count
// never comes back. Measured drift with no input: camera.direction.y moved by
// about 3e-16 per frame. checkForCameraUpdates does not see it, because it
// compares with a relative epsilon of 1e-15.
//
// CAUTION: a write to scene.msaaSamples makes CesiumJS destroy and rebuild the
// scene framebuffer on the next drawn frame (FramebufferManager.isDirty ->
// destroy -> new Texture + new Renderbuffer at the full canvas size). One
// transition therefore costs one allocation. moveStart and moveEnd each fire
// one time for each burst of movement, so one gesture costs two transitions.
// tools/dynamic-msaa-verify.js measures the real cost of a transition.

class DynamicMsaa {
    // options.scene   the Cesium scene. It needs msaaSamples, requestRender and
    //                 a camera with the moveStart and moveEnd events.
    constructor(options) {
        const scene = options.scene;
        const camera = scene.camera;

        this._scene = scene;
        this._enabled = false;
        this._targetSamples = scene.msaaSamples;
        this._moving = false;

        // Instrumentation for tools/dynamic-msaa-verify.js.
        this._transitions = 0;

        // moveStart runs before CesiumJS builds the frame, so the first frame of
        // the movement already draws at 1 sample. The movement draws its own
        // frames, so this path asks for none.
        camera.moveStart.addEventListener(() => {
            this._moving = true;
            this._apply();
        });

        // The scene is idle when the camera stops, so nothing else asks for the
        // frame that shows the smooth edges.
        camera.moveEnd.addEventListener(() => {
            this._moving = false;
            this._apply();
            this._scene.requestRender();
        });
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

export {DynamicMsaa}
