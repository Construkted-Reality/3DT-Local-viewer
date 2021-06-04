import {
    Cartesian3,
    Cesium3DTileset,
    Color,
    Transforms,
    Viewer,
} from "./CesiumJsInc.js";

import {geoReferenced} from "./util";

class TilesetViewer {
    constructor() {
        const viewer = new Viewer("cesiumContainer", {
            imageryProvider: false,
            animation: false,
            homeButton: false, //  the HomeButton widget will not be created.
            baseLayerPicker: true, // If set to false, the BaseLayerPicker widget will not be created.
            geocoder: false,
            sceneModePicker: false,
            timeline: true,
        });

        const scene = viewer.scene;

        scene.globe.show = false;
        scene.skyAtmosphere.show = false;
        scene.skyBox.show = false;
        scene.moon.show = false;
        scene.sun.show = false;
        scene.backgroundColor = Color.fromCssColorString("#333333");

        // customize credit display

        jQuery(".cesium-toolbar-button").hide();

        viewer.scene.preUpdate.addEventListener(function (scene, time) {
            const creditContainer = viewer.bottomContainer;

            jQuery("a[href='https://cesium.com/']").attr('href', "https://cesium.com/cesiumjs/");
            const cesiumjsIcon = "https://gw3.construkted.com/wp-content/themes/gowatch-child/images/cesiumjs.png";

            jQuery("img[title='Cesium ion']").attr('src', cesiumjsIcon);
            jQuery(".cesium-credit-textContainer").hide();
            jQuery(".cesium-credit-expand-link").html("Map data attribution");
        });

        viewer.extend(Cesium.viewerMeasureMixin, {
            units: new Cesium.MeasureUnits({
                distanceUnits: Cesium.DistanceUnits.METERS,
                areaUnits: Cesium.AreaUnits.SQUARE_METERS,
                volumeUnits: Cesium.VolumeUnits.CUBIC_METERS
            })
        });

        this._viewer = viewer;
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

            console.log(tileset.boundingSphere);
        }).otherwise((error) => {
            console.error(error);
        });
    }

    _onTilesetReady(tileset) {
        const viewer = this._viewer;

        viewer.zoomTo(tileset);
    }
}

export {TilesetViewer};