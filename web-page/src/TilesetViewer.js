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
    viewerCesium3DTilesInspectorMixin,
} from "./CesiumJsInc.js";

import {geoReferenced} from "./util";
import {CesiumFLYCameraController} from "./CesiumFLYCameraController";
import {NavigationControlbar} from "./NavigationControlbar"
import {mirrorTilesetSettings} from "./mirrorTilesetSettings";

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
        this._slotMeta = { left: undefined, right: undefined };
        this._benchmarkRunning = false;

        this._buildCompareSlider();
        this._buildStatsPanels();
        this._buildTilesInspector();
    }

    _buildTilesInspector() {
        this._viewer.extend(viewerCesium3DTilesInspectorMixin);
        this._inspector = this._viewer.cesium3DTilesInspector;
        this._inspector.container.style.display = "none";

        // The inspector edits a single tileset. Mirror its settings onto the
        // other compare side every frame so both views stay in sync.
        this._viewer.scene.preUpdate.addEventListener(() => {
            const source = this._inspector.viewModel.tileset;
            if (!source) return;
            const other = source === this._leftTileset ? this._rightTileset : this._leftTileset;
            mirrorTilesetSettings(source, other);
        });
    }

    setInspectorVisible(visible) {
        this._inspector.container.style.display = visible ? "block" : "none";
    }

    _buildStatsPanels() {
        const container = document.createElement("div");
        container.id = "statsContainer";

        const paneHtml = (slot) => `
            <div id="${slot}StatsPane" class="statsPane panel" style="display:none;">
                <div class="statsTitle" data-stats="${slot}Title">---</div>
                <div class="statsBody">
                    Tiles Loaded: <span data-stats="${slot}TilesLoaded">---</span> /
                    <span data-stats="${slot}TilesTotal">---</span>
                    <br />
                    GPU Memory: <span data-stats="${slot}GpuMemoryMB">---</span> MB
                    <div class="benchmarkNotice" data-stats="${slot}BenchmarkNotice"></div>
                    Tile Load Time (s): <span data-stats="${slot}TileLoadTime">---</span>
                </div>
            </div>`;
        container.innerHTML = paneHtml("left") + paneHtml("right");

        this._viewer.container.appendChild(container);

        const find = (key) => container.querySelector(`[data-stats="${key}"]`);
        const paneFor = (slot) => ({
            pane: container.querySelector(`#${slot}StatsPane`),
            title: find(`${slot}Title`),
            tilesLoaded: find(`${slot}TilesLoaded`),
            tilesTotal: find(`${slot}TilesTotal`),
            gpuMemoryMB: find(`${slot}GpuMemoryMB`),
            benchmarkNotice: find(`${slot}BenchmarkNotice`),
            tileLoadTime: find(`${slot}TileLoadTime`),
        });
        this._statsEls = { left: paneFor("left"), right: paneFor("right") };
    }

    _showStatsPane(slot, folderName) {
        const els = this._statsEls[slot];
        els.title.textContent = folderName || "(unnamed)";
        els.title.title = folderName || "";
        els.tilesLoaded.textContent = "---";
        els.tilesTotal.textContent = "---";
        els.gpuMemoryMB.textContent = "---";
        els.tileLoadTime.textContent = "---";
        els.benchmarkNotice.textContent = "Press 'Compute time to load' to measure load time";
        els.pane.style.display = "block";
    }

    _hideStatsPane(slot) {
        const els = this._statsEls[slot];
        els.pane.style.display = "none";
    }

    _updateStats(slot, tileset) {
        const els = this._statsEls[slot];
        const stats = tileset.statistics;
        els.tilesLoaded.textContent = stats.numberOfLoadedTilesTotal;
        els.tilesTotal.textContent = stats.numberOfTilesTotal;
        const gpuBytes = stats.geometryByteLength + stats.texturesByteLength;
        els.gpuMemoryMB.textContent = (gpuBytes / 1024 / 1024).toPrecision(3);
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

    addTileset(tilesetJsonUrl, folderName) {
        this._loadTilesetIntoSlot(tilesetJsonUrl, "left", folderName);
    }

    addRightTileset(tilesetJsonUrl, folderName) {
        this._loadTilesetIntoSlot(tilesetJsonUrl, "right", folderName);
    }

    _loadTilesetIntoSlot(tilesetJsonUrl, slot, folderName, options = {}) {
        const viewer = this._viewer;
        const slotKey = slot === "right" ? "_rightTileset" : "_leftTileset";

        const wasInspectorTarget = this._inspector.viewModel.tileset === this[slotKey];

        if (this[slotKey]) {
            viewer.scene.primitives.remove(this[slotKey]);
            this[slotKey] = undefined;
            this._hideStatsPane(slot);
        }
        this._slotMeta[slot] = { url: tilesetJsonUrl, folderName };

        return new Promise((resolve, reject) => {
            Cesium3DTileset.fromUrl(tilesetJsonUrl).then((tileset) => {
                viewer.scene.primitives.add(tileset);
                this[slotKey] = tileset;

                if (wasInspectorTarget || !this._inspector.viewModel.tileset) {
                    this._inspector.viewModel.tileset = tileset;
                }

                this._applyPointCloudShadingDefaults(tileset);

                if (!geoReferenced(tileset)) {
                    tileset.modelMatrix = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0));
                }

                this._showStatsPane(slot, folderName);
                const onTileChange = () => this._updateStats(slot, tileset);
                tileset.tileLoad.addEventListener(onTileChange);
                tileset.tileUnload.addEventListener(onTileChange);
                this._updateStats(slot, tileset);

                this._updateCompareMode();
                this._onTilesetReady(tileset, slot, options);

                const onInitial = () => {
                    tileset.initialTilesLoaded.removeEventListener(onInitial);
                    resolve(tileset);
                };
                tileset.initialTilesLoaded.addEventListener(onInitial);
            }).catch((error) => {
                this._tilesetLoadError.raiseEvent(error);
                console.error(error);
                reject(error);
            });
        });
    }

    async computeLoadTimes() {
        if (this._benchmarkRunning) return;
        this._benchmarkRunning = true;
        try {
            if (this._slotMeta.left) await this._benchmarkSlot("left");
            if (this._slotMeta.right) await this._benchmarkSlot("right");
        } finally {
            this._benchmarkRunning = false;
        }
    }

    async _benchmarkSlot(slot) {
        const meta = this._slotMeta[slot];
        if (!meta) return;
        const els = this._statsEls[slot];
        els.tileLoadTime.textContent = "---";
        els.benchmarkNotice.textContent = "";

        const startMs = performance.now();
        try {
            await this._loadTilesetIntoSlot(meta.url, slot, meta.folderName, { suppressZoom: true });
        } catch (e) {
            return;
        }
        const elapsedSec = (performance.now() - startMs) / 1000.0;
        // _loadTilesetIntoSlot calls _showStatsPane which resets the notice.
        // Clear it again and write the measured time.
        els.benchmarkNotice.textContent = "";
        els.tileLoadTime.textContent = elapsedSec.toPrecision(3);
    }

    _onTilesetReady(tileset, slot, options = {}) {
        const viewer = this._viewer;

        if (slot === "left" && !options.suppressZoom) {
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
