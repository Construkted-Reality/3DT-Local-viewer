import {Cesium3DTileset} from "./CesiumJsInc.js";

function initSettingsPopup() {
    jQuery('#maximum-screen-space-error-slider').change(function () {
        const scene = window.tilesetViewer.viewer.scene;

        for (let i = 0; i < scene.primitives.length; ++i) {
            const primitive = scene.primitives.get(i);

            if(primitive instanceof Cesium3DTileset)
                primitive.maximumScreenSpaceError = 32 - this.value;
        }

        scene.requestRender();
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

    jQuery('#show-hide-tiles-inspector-checkbox').change(function () {
        showHideTilesInspector(this.checked);
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