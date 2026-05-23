import {
    CameraEventType,
    Cartesian3,
    Cesium3DTileset,
    Color,
    Ion,
    KeyboardEventModifier,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    SplitDirection,
    Transforms,
    Viewer,
} from "./CesiumJsInc.js";

import {geoReferenced} from "./util";
import {CesiumFLYCameraController} from "./CesiumFLYCameraController";
import {NavigationControlbar} from "./NavigationControlbar"

class TilesetViewer {
    constructor() {
        Ion.defaultAccessToken = "";

        const viewer = new Viewer("cesiumContainer", {
            imageryProvider: false,
            animation: false,
            homeButton: false, //  the HomeButton widget will not be created.

            // note that If set to false, credit display will not show
            baseLayerPicker: false,
            geocoder: false,
            sceneModePicker: false,
            timeline: false,
        });

        this._viewer = viewer;

        const scene = viewer.scene;

        scene.globe.show = false;
        scene.skyAtmosphere.show = false;
        scene.skyBox.show = false;
        scene.moon.show = false;
        scene.sun.show = false;
        scene.backgroundColor = Color.fromCssColorString("#333333");

        // customize credit display

        jQuery(".cesium-toolbar-button").hide();

        viewer.scene.screenSpaceCameraController.rotateEventTypes = CameraEventType.LEFT_DRAG;
        viewer.scene.screenSpaceCameraController.zoomEventTypes = [CameraEventType.MIDDLE_DRAG, CameraEventType.WHEEL, CameraEventType.PINCH];

        viewer.scene.screenSpaceCameraController.tiltEventTypes = [
            CameraEventType.RIGHT_DRAG, CameraEventType.PINCH,
            {
                eventType: CameraEventType.RIGHT_DRAG,
                modifier: KeyboardEventModifier.CTRL
            },
            {
                eventType: CameraEventType.LEFT_DRAG,
                modifier: KeyboardEventModifier.CTRL
            }
        ];

        viewer.scene.postUpdate.addEventListener(function (scene, time) {
            const creditContainer = viewer.bottomContainer;

            jQuery("a[href='https://cesium.com/']").attr('href', "https://cesium.com/cesiumjs/");
            const cesiumjsIcon = "https://gw3.construkted.com/wp-content/themes/gowatch-child/images/cesiumjs.png";

            jQuery("img[title='Cesium ion']").attr('src', cesiumjsIcon);
            jQuery(".cesium-credit-textContainer").hide();
            jQuery(".cesium-credit-expand-link").show();
            jQuery(".cesium-credit-expand-link").html("Map data attribution");
        });

        this._flyController = new CesiumFLYCameraController({
            isMobile: false,
            cesiumViewer: this._viewer
        });

        const controlbarContainer = document.createElement("div");

        controlbarContainer.className = "construkted-viewer-controlbarContainer";

        this._viewer.container.appendChild(controlbarContainer);

        const controlbar = new NavigationControlbar({
            viewer: this._viewer,
            container: controlbarContainer,
            flyController: this._flyController,
        });

        // TODO(measurement): re-enable measurement tools.
        // The previous bundled CesiumMeasurementPlugin.js targeted Cesium 1.81's
        // internals and breaks against 1.140 (Cesium.EMPTY_OBJECT no longer exposed).
        // Replace with a current-Cesium-compatible measurement implementation
        // (or rewrite using the public Cesium API).

        this._tilesetLoadError = new Cesium.Event();
        this._tilesetLoaded = new Cesium.Event();

        this._leftTileset = undefined;
        this._rightTileset = undefined;

        this._buildCompareSlider();
        this._buildPathLabels();
    }

    _buildPathLabels() {
        const left = document.createElement("div");
        left.className = "tileset-path-label tileset-path-label--left";
        left.style.display = "none";

        const right = document.createElement("div");
        right.className = "tileset-path-label tileset-path-label--right";
        right.style.display = "none";

        this._viewer.container.appendChild(left);
        this._viewer.container.appendChild(right);
        this._leftPathLabel = left;
        this._rightPathLabel = right;
    }

    _updatePathLabel(slot, displayPath) {
        const label = slot === "right" ? this._rightPathLabel : this._leftPathLabel;
        if (!label) return;
        if (displayPath) {
            label.textContent = displayPath;
            label.title = displayPath;
            label.style.display = "block";
        } else {
            label.textContent = "";
            label.style.display = "none";
        }
    }

    _buildCompareSlider() {
        const slider = document.createElement("div");
        slider.id = "compare-slider";
        slider.style.display = "none";
        this._viewer.container.appendChild(slider);
        this._slider = slider;

        const handler = new ScreenSpaceEventHandler(slider);
        let moveActive = false;

        const move = (movement) => {
            if (!moveActive) return;
            const relativeOffset = movement.endPosition.x;
            const splitPosition =
                (slider.offsetLeft + relativeOffset) / slider.parentElement.offsetWidth;
            slider.style.left = `${100.0 * splitPosition}%`;
            this._viewer.scene.splitPosition = splitPosition;
        };

        handler.setInputAction(() => { moveActive = true; }, ScreenSpaceEventType.LEFT_DOWN);
        handler.setInputAction(() => { moveActive = true; }, ScreenSpaceEventType.PINCH_START);
        handler.setInputAction(move, ScreenSpaceEventType.MOUSE_MOVE);
        handler.setInputAction(move, ScreenSpaceEventType.PINCH_MOVE);
        handler.setInputAction(() => { moveActive = false; }, ScreenSpaceEventType.LEFT_UP);
        handler.setInputAction(() => { moveActive = false; }, ScreenSpaceEventType.PINCH_END);
    }

    _applyPointCloudShadingDefaults(tileset) {
        tileset.pointCloudShading.attenuation = true;
        tileset.pointCloudShading.geometricErrorScale = 1.0;
        tileset.pointCloudShading.maximumAttenuation = undefined;
        tileset.pointCloudShading.baseResolution = undefined;
        tileset.pointCloudShading.eyeDomeLighting = true;
        tileset.pointCloudShading.eyeDomeLightingStrength = 1.0;
        tileset.pointCloudShading.eyeDomeLightingRadius = 1.0;
        tileset.pointCloudShading.backFaceCulling = false;
        tileset.pointCloudShading.normalShading = true;
    }

    _updateCompareMode() {
        const bothLoaded = this._leftTileset && this._rightTileset;
        if (bothLoaded) {
            this._leftTileset.splitDirection = SplitDirection.LEFT;
            this._rightTileset.splitDirection = SplitDirection.RIGHT;
            const slider = this._slider;
            slider.style.display = "block";
            slider.style.left = "50%";
            this._viewer.scene.splitPosition =
                slider.offsetLeft / slider.parentElement.offsetWidth;
        } else {
            if (this._leftTileset) this._leftTileset.splitDirection = SplitDirection.NONE;
            if (this._rightTileset) this._rightTileset.splitDirection = SplitDirection.NONE;
            this._slider.style.display = "none";
        }
    }

    addTileset(tilesetJsonUrl, displayPath) {
        this._loadTilesetIntoSlot(tilesetJsonUrl, "left", displayPath);
    }

    addRightTileset(tilesetJsonUrl, displayPath) {
        this._loadTilesetIntoSlot(tilesetJsonUrl, "right", displayPath);
    }

    _loadTilesetIntoSlot(tilesetJsonUrl, slot, displayPath) {
        const viewer = this._viewer;
        const slotKey = slot === "right" ? "_rightTileset" : "_leftTileset";

        if (this[slotKey]) {
            viewer.scene.primitives.remove(this[slotKey]);
            this[slotKey] = undefined;
            this._updatePathLabel(slot, undefined);
        }

        Cesium3DTileset.fromUrl(tilesetJsonUrl).then((tileset) => {
            viewer.scene.primitives.add(tileset);
            this[slotKey] = tileset;

            this._applyPointCloudShadingDefaults(tileset);

            if (!geoReferenced(tileset)) {
                tileset.modelMatrix = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0));
            }

            this._updatePathLabel(slot, displayPath || tilesetJsonUrl);
            this._updateCompareMode();
            this._onTilesetReady(tileset, slot);
        }).catch((error) => {
            this._tilesetLoadError.raiseEvent(error);
            console.error(error);
        });
    }

    _onTilesetReady(tileset, slot) {
        const viewer = this._viewer;

        if (slot === "left") {
            viewer.zoomTo(tileset);
        }
        this._tilesetLoaded.raiseEvent(tileset);
    }

    get viewer () {
        return this._viewer;
    }

    get flyController() {
        return this._flyController;
    }

    get tilesetLoadError() {
        return this._tilesetLoadError;
    }

    get tilesetLoaded() {
        return this._tilesetLoaded;
    }

}

export {TilesetViewer};
