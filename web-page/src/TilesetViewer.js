import {
    CameraEventType,
    Cartesian3,
    Cesium3DTileset,
    Color,
    Ion,
    KeyboardEventModifier,
    Transforms,
    Viewer,
} from "./CesiumJsInc.js";

import {geoReferenced} from "./util";
import {CesiumFLYCameraController} from "./CesiumFLYCameraController";
import {NavigationControlbar} from "./NavigationControlbar"

class TilesetViewer {
    constructor() {
        // construkted token
        Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI2M…jk1fQ.jMg72t7Gnkk4-E9G7zhd_CoTJBUJ39hHALmxGBRL1ok";

        const viewer = new Viewer("cesiumContainer", {
            imageryProvider: false,
            animation: false,
            homeButton: false, //  the HomeButton widget will not be created.

            // note that If set to false, credit display will not show
            baseLayerPicker: true, // If set to false, the BaseLayerPicker widget will not be created.
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

        viewer.extend(Cesium.viewerMeasureMixin, {
            units: new Cesium.MeasureUnits({
                distanceUnits: Cesium.DistanceUnits.METERS,
                areaUnits: Cesium.AreaUnits.SQUARE_METERS,
                volumeUnits: Cesium.VolumeUnits.CUBIC_METERS
            })
        });

        this._tilesetLoadError = new Cesium.Event();
    }

    addTileset(tilesetJsonUrl) {
        const viewer = this._viewer;

        if(this._tileset) {
            viewer.scene.primitives.remove(this._tileset);
        }

        const tileset = new Cesium3DTileset({
            url: tilesetJsonUrl
        });

        viewer.scene.primitives.add(tileset);

        this._tileset = tileset;

        tileset.readyPromise.then(() => {
            this._onTilesetReady(tileset);

            if (geoReferenced(tileset)) {

            }
            else {
                tileset.modelMatrix = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0));
            }
        }).otherwise((error) => {
            this._tilesetLoadError.raiseEvent(error);
            console.error(error);
        });
    }

    _onTilesetReady(tileset) {
        const viewer = this._viewer;

        viewer.zoomTo(tileset);
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

}

export {TilesetViewer};