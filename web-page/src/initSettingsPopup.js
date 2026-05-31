import {Cesium3DTileset} from "./CesiumJsInc.js";

function initSettingsPopup() {
    const sseSlider = jQuery('#maximum-screen-space-error-slider');
    const sseValueInput = jQuery('#maximum-screen-space-error-value');

    function applyScreenSpaceError(sliderValue) {
        const scene = window.tilesetViewer.viewer.scene;
        const sse = Math.max(1, 32 - parseFloat(sliderValue));

        for (let i = 0; i < scene.primitives.length; ++i) {
            const primitive = scene.primitives.get(i);

            if(primitive instanceof Cesium3DTileset)
                primitive.maximumScreenSpaceError = sse;
        }

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

        for (let i = 0; i < scene.primitives.length; ++i) {
            const primitive = scene.primitives.get(i);

            if(primitive instanceof Cesium3DTileset)
                primitive.skipLevelOfDetail = this.checked;
        }

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

        for (let i = 0; i < scene.primitives.length; ++i) {
            const primitive = scene.primitives.get(i);

            if(primitive instanceof Cesium3DTileset)
                primitive.cacheBytes = bytes;
        }

        scene.requestRender();
    });

    window.tilesetViewer.tilesetLoaded.addEventListener((tileset) => {
        const sliderValue = 32 - tileset.maximumScreenSpaceError;
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

        for (let i = 0; i < scene.primitives.length; ++i) {
            const primitive = scene.primitives.get(i);

            if(primitive instanceof Cesium3DTileset)
                primitive.debugWireframe = this.checked;
        }

        scene.requestRender();
    });

    jQuery('#show-bounding-box-checkbox').change(function () {
        const scene = window.tilesetViewer.viewer.scene;

        for (let i = 0; i < scene.primitives.length; ++i) {
            const primitive = scene.primitives.get(i);

            if(primitive instanceof Cesium3DTileset)
                primitive.debugShowBoundingVolume = this.checked;
        }

        scene.requestRender();
    });

    jQuery('#show-hide-tiles-inspector-checkbox').change(function () {
        window.tilesetViewer.setInspectorVisible(this.checked);
    });

    const jQFxaaEnableCheckBox = jQuery('#fxaa-enable-checkbox');

    jQFxaaEnableCheckBox.prop('checked', () => {
        const viewer = window.tilesetViewer.viewer;

        return viewer.scene.postProcessStages.fxaa.enabled
    });

    jQFxaaEnableCheckBox.change(function () {
        const viewer = window.tilesetViewer.viewer;

        viewer.scene.postProcessStages.fxaa.enabled = this.checked;
    });
}

export {initSettingsPopup}