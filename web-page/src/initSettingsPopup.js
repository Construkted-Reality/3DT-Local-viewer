import {Cesium3DTileset} from "./CesiumJsInc.js";
import {getAppVersion} from "./appVersion.js";
import {DynamicMsaa} from "./DynamicMsaa.js";

// The SSE slider runs 0..SSE_SLIDER_MAX and maps inversely to screen-space
// error (higher slider = lower SSE = higher detail). Keep both directions in sync.
const SSE_SLIDER_MAX = 32;

// How often the performance readout refreshes, in milliseconds. It is also the
// window over which the frame rate and the frame time are averaged.
const PERF_WINDOW_MS = 500;

// Apply fn to every Cesium3DTileset currently in the scene.
function forEachTileset(scene, fn) {
    for (let i = 0; i < scene.primitives.length; ++i) {
        const primitive = scene.primitives.get(i);

        if (primitive instanceof Cesium3DTileset)
            fn(primitive);
    }
}

function initSettingsPopup() {
    const sseSlider = jQuery('#maximum-screen-space-error-slider');
    const sseValueInput = jQuery('#maximum-screen-space-error-value');

    function applyScreenSpaceError(sliderValue) {
        const scene = window.tilesetViewer.viewer.scene;
        const sse = Math.max(1, SSE_SLIDER_MAX - parseFloat(sliderValue));

        forEachTileset(scene, (tileset) => {
            tileset.maximumScreenSpaceError = sse;
        });

        scene.requestRender();
    }

    sseSlider.on('input change', function () {
        sseValueInput.val(this.value);
        applyScreenSpaceError(this.value);
    });

    // The number input commits on Enter or when focus leaves (Tab), both of
    // which fire a 'change' event. Clamp to the slider's range before applying.
    sseValueInput.on('change', function () {
        const min = parseFloat(this.min);
        const max = parseFloat(this.max);
        let value = parseFloat(this.value);

        if (isNaN(value))
            value = parseFloat(sseSlider.val());

        value = Math.min(max, Math.max(min, value));

        this.value = value;
        sseSlider.val(value);
        applyScreenSpaceError(value);
    });

    const skipLodCheckbox = jQuery('#skip-level-of-detail-checkbox');
    const cacheMemoryInput = jQuery('#tile-cache-memory-value');

    skipLodCheckbox.change(function () {
        const scene = window.tilesetViewer.viewer.scene;
        const checked = this.checked;

        forEachTileset(scene, (tileset) => {
            tileset.skipLevelOfDetail = checked;
        });

        scene.requestRender();
    });

    // Number input commits on Enter or blur (both fire 'change'). The value is
    // in MB; Cesium's cacheBytes is in bytes. Clamp to the input's minimum.
    cacheMemoryInput.on('change', function () {
        const min = parseFloat(this.min);
        let megabytes = parseFloat(this.value);

        if (isNaN(megabytes) || megabytes < min)
            megabytes = min;

        this.value = megabytes;

        const scene = window.tilesetViewer.viewer.scene;
        const bytes = megabytes * 1024 * 1024;

        forEachTileset(scene, (tileset) => {
            tileset.cacheBytes = bytes;
        });

        scene.requestRender();
    });

    window.tilesetViewer.tilesetLoaded.addEventListener((tileset) => {
        const sliderValue = SSE_SLIDER_MAX - tileset.maximumScreenSpaceError;
        sseSlider.val(sliderValue);
        sseValueInput.val(sliderValue);
        skipLodCheckbox.prop('checked', tileset.skipLevelOfDetail);
        cacheMemoryInput.val(Math.round(tileset.cacheBytes / 1024 / 1024));
    });

    jQuery('#fpv-movement-speed-slider').change(function () {
        window.tilesetViewer.flyController.setMoveRateFactor(parseFloat(this.value));
    });

    jQuery('#show-hide-wireframe-checkbox').change(function () {
        const scene = window.tilesetViewer.viewer.scene;
        const checked = this.checked;

        forEachTileset(scene, (tileset) => {
            tileset.debugWireframe = checked;
        });

        scene.requestRender();
    });

    jQuery('#show-bounding-box-checkbox').change(function () {
        const scene = window.tilesetViewer.viewer.scene;
        const checked = this.checked;

        forEachTileset(scene, (tileset) => {
            tileset.debugShowBoundingVolume = checked;
        });

        scene.requestRender();
    });

    jQuery('#show-hide-tiles-inspector-checkbox').change(function () {
        window.tilesetViewer.setInspectorVisible(this.checked);
    });

    const jQFxaaEnableCheckBox = jQuery('#fxaa-enable-checkbox');

    jQFxaaEnableCheckBox.prop('checked', window.tilesetViewer.viewer.scene.postProcessStages.fxaa.enabled);

    jQFxaaEnableCheckBox.change(function () {
        const viewer = window.tilesetViewer.viewer;

        viewer.scene.postProcessStages.fxaa.enabled = this.checked;
        viewer.scene.requestRender();
    });

    // Multisampling. scene.msaaSamples is a live property (default 4). A value
    // of 1 turns it off. The scene ignores it when the context has no MSAA
    // support, so disable the control in that case.
    //
    // The selector no longer writes the property itself. DynamicMsaa owns it,
    // because the second control below can hold the chosen count back until the
    // camera stops. With that control off, DynamicMsaa passes the choice
    // straight through.
    const msaaSelect = jQuery('#msaa-samples-select');
    const msaaDynamicCheckbox = jQuery('#msaa-dynamic-checkbox');
    const msaaScene = window.tilesetViewer.viewer.scene;

    if (msaaScene.msaaSupported) {
        const dynamicMsaa = new DynamicMsaa({scene: msaaScene});

        // Other code reads the state through the viewer: the verification tool
        // in tools/dynamic-msaa-verify.js needs the transition count.
        window.tilesetViewer.dynamicMsaa = dynamicMsaa;

        msaaSelect.val(String(dynamicMsaa.targetSamples));
        dynamicMsaa.setEnabled(msaaDynamicCheckbox.prop('checked'));

        msaaSelect.change(function () {
            dynamicMsaa.setTargetSamples(parseInt(this.value, 10));
        });

        msaaDynamicCheckbox.change(function () {
            dynamicMsaa.setEnabled(this.checked);
        });
    } else {
        msaaSelect.val('1');
        msaaSelect.prop('disabled', true);
        msaaDynamicCheckbox.prop('checked', false);
        msaaDynamicCheckbox.prop('disabled', true);
    }

    initPerformanceReadout();

    getAppVersion().then((version) => jQuery('#app-version-value').text(version));
}

// GPU frame time comes from a WebGL2 timer query. The extension is a draft one,
// so Chromium exposes it only when the main process passes
// --enable-webgl-draft-extensions (see index.js). A driver can still refuse it.
const GPU_TIMER_EXTENSION = 'EXT_disjoint_timer_query_webgl2';

// Wraps one TIME_ELAPSED query around each drawn frame. The GPU answers a few
// frames late, so begin/end only queue the work and collect() reads whatever
// finished since the last call. Returns null when the extension is missing.
//
// Two rules of the extension drive this code:
//   1. Only one TIME_ELAPSED query can be active on a context at a time.
//   2. A "disjoint" period means the GPU changed context and every result in
//      that period is wrong. Throw those results away.
function createGpuTimer(scene) {
    const canvas = scene.canvas;
    const gl = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('webgl2') : null;
    const ext = gl ? gl.getExtension(GPU_TIMER_EXTENSION) : null;

    if (!ext)
        return null;

    let active = null;
    let pending = [];

    return {
        begin() {
            if (active)
                return;

            const query = gl.createQuery();

            gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
            active = query;
        },

        end() {
            if (!active)
                return;

            gl.endQuery(ext.TIME_ELAPSED_EXT);
            pending.push(active);
            active = null;
        },

        // Mean of the results that finished since the last call, in
        // milliseconds, or null when nothing finished.
        collect() {
            const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
            const stillPending = [];
            let total = 0;
            let count = 0;

            for (const query of pending) {
                if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
                    stillPending.push(query);
                    continue;
                }

                if (!disjoint) {
                    total += gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
                    count += 1;
                }

                gl.deleteQuery(query);
            }

            pending = stillPending;

            return count > 0 ? total / count : null;
        },
    };
}

// Formats the GPU value. Exported for the unit test.
function formatGpuWindow(frames, meanMs, supported) {
    if (!supported)
        return 'not available';

    if (frames <= 0)
        return 'idle';

    if (meanMs === null || meanMs === undefined)
        return 'measuring';

    return meanMs.toFixed(1) + ' ms';
}

// Formats one measurement window for the readout. A window with no drawn frame
// reads "idle", which is the normal state of a scene that nothing changes.
// Exported for the unit test.
function formatPerfWindow(frames, totalMs, elapsedMs) {
    if (frames <= 0 || elapsedMs <= 0)
        return {fps: 'idle', frameMs: 'idle'};

    return {
        fps: Math.round(frames * 1000 / elapsedMs) + ' fps',
        frameMs: (totalMs / frames).toFixed(1) + ' ms',
    };
}

// Live frame-rate and frame-time readout in the settings panel.
//
// Cesium raises preRender and postRender ONLY for the frames that it really
// draws (see the requestRenderMode note in CLAUDE.md), so a count of those
// events is a true frame rate. The span between the two events is the CPU time
// of the render call. It does not include the GPU time, because postRender
// fires when Cesium has issued the draw commands, not when the GPU finishes
// them. Both handlers must stay cheap, because they run on every drawn frame.
function initPerformanceReadout() {
    const fpsEl = jQuery('#perf-fps-value');
    const frameMsEl = jQuery('#perf-frame-ms-value');
    const gpuMsEl = jQuery('#perf-gpu-ms-value');
    const popup = jQuery('#construkted-popup-settings');
    const scene = window.tilesetViewer.viewer.scene;
    const gpuTimer = createGpuTimer(scene);

    let frameStart = 0;
    let frames = 0;
    let totalMs = 0;
    let lastGpuMs = null;

    scene.preRender.addEventListener(function () {
        frameStart = performance.now();

        if (gpuTimer)
            gpuTimer.begin();
    });

    scene.postRender.addEventListener(function () {
        if (gpuTimer)
            gpuTimer.end();

        totalMs += performance.now() - frameStart;
        frames += 1;
    });

    // An idle scene draws no frame and raises no event, so a timer does the
    // update. It reads the counters, then clears them for the next window. The
    // timer writes to the DOM only while the settings panel is open.
    let windowStart = performance.now();

    setInterval(function () {
        const now = performance.now();
        const elapsed = now - windowStart;
        const framesInWindow = frames;
        const msInWindow = totalMs;
        const gpuSample = gpuTimer ? gpuTimer.collect() : null;

        windowStart = now;
        frames = 0;
        totalMs = 0;

        // A query can arrive after its window closes, so keep the last result
        // and show it until a newer one arrives.
        if (gpuSample !== null)
            lastGpuMs = gpuSample;

        if (!popup.is(':visible'))
            return;

        const text = formatPerfWindow(framesInWindow, msInWindow, elapsed);

        fpsEl.text(text.fps);
        frameMsEl.text(text.frameMs);
        gpuMsEl.text(formatGpuWindow(framesInWindow, lastGpuMs, gpuTimer !== null));
    }, PERF_WINDOW_MS);
}

export {initSettingsPopup, formatPerfWindow, formatGpuWindow, createGpuTimer}
