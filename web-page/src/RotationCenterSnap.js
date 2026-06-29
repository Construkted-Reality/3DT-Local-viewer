import {
    Cartesian2,
    Cartesian3,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
} from "./CesiumJsInc.js";

// Snaps the camera's rotate/tilt/zoom pivot to the nearest visible tileset point
// near the cursor, and shows a crosshair marker at the rotation centre.
//
// HOW: Cesium's ScreenSpaceCameraController derives every gesture pivot from
// scene.pickPositionWorldCoordinates (verified for 1.142 by tools/pivot-probe.js:
// rotate calls it 1x, tilt 1x, zoom 40-60x). We shadow that one instance method
// with a neighbourhood search: sample the cursor pixel plus a ring of points at
// SNAP_RADIUS_PX, and return the hit NEAREST THE CAMERA. "Nearest the camera"
// (not nearest the cursor) is deliberate — if the user clicks through a hole in a
// lattice tower, the close member a few px away wins over the far background seen
// through the gap, so they orbit the thing they meant to.
//
// A genuine miss (no geometry within the ring) returns undefined, exactly as the
// stock method would: with the globe hidden there is no far-ellipsoid fallback, so
// the controller just rotates in place — benign.
//
// This wrap is intentionally the whole feature: snapping the pick snaps the pivot
// for rotate, tilt AND zoom at once, with no fork of Cesium's controller. The
// alternative — owning the orbit/pan/zoom handlers ourselves — is recorded as a
// future option in docs/reports (Adrian wants to try it later); see CLAUDE.md.

// Search radius (px) around the cursor. A modest value: large enough to grab a
// silhouette edge or a near lattice member, small enough not to yank the pivot
// onto unrelated geometry. No settings UI by decision; tune here if needed.
const SNAP_RADIUS_PX = 16;
// Ring sample count. Center + RING_SAMPLES points = total depth reads per resolve.
// 8 keeps cost at the proven 9-reads-per-pick level the web platform shipped.
const RING_SAMPLES = 8;

// Crosshair marker: a circle with a centre dot, drawn as an SVG data URI so we
// carry no image asset. disableDepthTestDistance keeps it visible through geometry.
const MARKER_SVG =
    "data:image/svg+xml;base64," + btoa(
        "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'>" +
        "<g fill='none' stroke='#ffffff' stroke-width='2'>" +
        "<circle cx='20' cy='20' r='11'/>" +
        "<line x1='20' y1='2' x2='20' y2='12'/><line x1='20' y1='28' x2='20' y2='38'/>" +
        "<line x1='2' y1='20' x2='12' y2='20'/><line x1='28' y1='20' x2='38' y2='20'/>" +
        "</g><circle cx='20' cy='20' r='2.5' fill='#ff3b30'/></svg>"
    );

class RotationCenterSnap {
    // options: { viewer, isFlyActive?: () => boolean }
    constructor(options) {
        this._viewer = options.viewer;
        this._scene = this._viewer.scene;
        // When fly mode owns the camera the default controller is disabled and the
        // wrap is never called anyway; this only gates the marker.
        this._isFlyActive = options.isFlyActive || (() => false);

        this._installPickWrap();
        this._installMarker();
        this._installGestureHandler();
    }

    // --- pivot pick wrap -----------------------------------------------------

    _installPickWrap() {
        const scene = this._scene;
        // Bind the prototype method as the un-snapped fallback, then shadow it on
        // the instance. resolve() calls _origPick (never the shadow) to avoid
        // infinite recursion.
        this._origPick = scene.pickPositionWorldCoordinates.bind(scene);

        // Per-frame memo so a zoom burst's 40+ same-pixel picks collapse to one
        // neighbourhood search per frame. Cleared each frame.
        this._memo = new Map();
        this._frame = 0;
        scene.preRender.addEventListener(() => {
            this._frame++;
            this._memo.clear();
        });

        scene.pickPositionWorldCoordinates = (windowPosition, result) => {
            const snapped = this._resolve(windowPosition);
            if (snapped) {
                return Cartesian3.clone(snapped, result);
            }
            return this._origPick(windowPosition, result);
        };
    }

    // Nearest-to-camera hit within SNAP_RADIUS_PX of windowPosition, or undefined.
    _resolve(windowPosition) {
        const key = Math.round(windowPosition.x) + "," + Math.round(windowPosition.y);
        if (this._memo.has(key)) {
            return this._memo.get(key);
        }

        const camPos = this._scene.camera.positionWC;
        let best;
        let bestDist = Number.POSITIVE_INFINITY;

        const consider = (x, y) => {
            scratchSample.x = x;
            scratchSample.y = y;
            const hit = this._origPick(scratchSample, scratchHit);
            if (!hit) return;
            const d = Cartesian3.distance(hit, camPos);
            if (d < bestDist) {
                bestDist = d;
                best = Cartesian3.clone(hit, best === undefined ? new Cartesian3() : best);
            }
        };

        consider(windowPosition.x, windowPosition.y);
        for (let i = 0; i < RING_SAMPLES; i++) {
            const a = (2 * Math.PI * i) / RING_SAMPLES;
            consider(
                windowPosition.x + SNAP_RADIUS_PX * Math.cos(a),
                windowPosition.y + SNAP_RADIUS_PX * Math.sin(a),
            );
        }

        this._memo.set(key, best);
        return best;
    }

    // --- rotation-centre marker ---------------------------------------------

    _installMarker() {
        this._marker = this._viewer.entities.add({
            show: false,
            position: new Cartesian3(),
            billboard: {
                image: MARKER_SVG,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scale: 1.0,
            },
        });
    }

    _showMarkerAt(point) {
        this._marker.position = point;
        this._marker.show = true;
        this._scene.requestRender();
    }

    _hideMarker() {
        if (!this._marker.show) return;
        this._marker.show = false;
        this._scene.requestRender();
    }

    // --- gesture wiring ------------------------------------------------------

    // The marker indicates the ROTATION centre, so it's bound to plain left-drag
    // (this app maps rotate -> LEFT_DRAG). The pivot Cesium will orbit comes from
    // the same _resolve() the wrap uses, so the marker and the orbit centre agree.
    _installGestureHandler() {
        this._handler = new ScreenSpaceEventHandler(this._scene.canvas);

        this._handler.setInputAction((event) => {
            if (this._isFlyActive()) return;
            const point = this._resolve(event.position);
            if (point) {
                this._showMarkerAt(point);
            }
        }, ScreenSpaceEventType.LEFT_DOWN);

        this._handler.setInputAction(() => this._hideMarker(), ScreenSpaceEventType.LEFT_UP);
    }
}

const scratchSample = new Cartesian2();
const scratchHit = new Cartesian3();

export { RotationCenterSnap };
