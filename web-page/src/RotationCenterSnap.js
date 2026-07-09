import {
    Cartesian2,
    Cartesian3,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
} from "./CesiumJsInc.js";

import {SplatPivotSource} from "./SplatPivotSource.js";

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

// Splat fallback search radius (px). Larger than the mesh ring because decimated
// splat centres are sparser than per-pixel depth, so the cursor needs a wider catch.
const SPLAT_SNAP_RADIUS_PX = 28;

// Screen radius (px) of the full-density refine catchment for a measurement click. Small
// — we want the splat centres local to the clicked feature, not a wide neighbourhood.
const MEASURE_REFINE_RADIUS_PX = 12;

// Screen radius (px) for refining the spin/tilt pivot to full density. Same catchment as a
// measurement click; the gain over the decimated pivot is small but the cost is one refine
// per gesture (spin/tilt pick once), so it's affordable — unlike zoom (40-60 picks/gesture,
// left on the decimated query).
const PIVOT_REFINE_RADIUS_PX = 12;

// Crosshair marker: a circle with a centre dot, drawn as an SVG data URI so we carry
// no image asset. disableDepthTestDistance keeps it visible through geometry. The
// crosshair is drawn twice — a wide dark halo under a white stroke — so it reads on
// both dark geometry and bright (e.g. over-exposed splat) backgrounds.
const MARKER_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'>" +
    "<g fill='none'>" +
    "<g stroke='#000000' stroke-width='4.5' stroke-opacity='0.55'>" +
    "<circle cx='20' cy='20' r='11'/>" +
    "<line x1='20' y1='2' x2='20' y2='12'/><line x1='20' y1='28' x2='20' y2='38'/>" +
    "<line x1='2' y1='20' x2='12' y2='20'/><line x1='28' y1='20' x2='38' y2='20'/>" +
    "</g>" +
    "<g stroke='#ffffff' stroke-width='2'>" +
    "<circle cx='20' cy='20' r='11'/>" +
    "<line x1='20' y1='2' x2='20' y2='12'/><line x1='20' y1='28' x2='20' y2='38'/>" +
    "<line x1='2' y1='20' x2='12' y2='20'/><line x1='28' y1='20' x2='38' y2='20'/>" +
    "</g></g>" +
    "<circle cx='20' cy='20' r='3' fill='#ff3b30' stroke='#000000' stroke-width='1'/></svg>";

class RotationCenterSnap {
    // options: { viewer, isFlyActive?: () => boolean, getTilesets?: () => Array }
    constructor(options) {
        this._viewer = options.viewer;
        this._scene = this._viewer.scene;
        // When fly mode owns the camera the default controller is disabled and the
        // wrap is never called anyway; this only gates the marker.
        this._isFlyActive = options.isFlyActive || (() => false);
        // While measure mode is active, suppress the pivot crosshair on left-down so it
        // doesn't compete with the measurement overlay (orbit-drag still works).
        this._isMeasureActive = options.isMeasureActive || (() => false);

        // Active drag gesture: "spin" (left-drag), "tilt" (right-drag), or null. Only
        // spin/tilt refine their pivot to full density (they pick once per gesture); zoom
        // does not (it picks 40-60x). Set by the gesture handler.
        this._gesture = null;
        // Monotonic count of splat-pivot refines actually performed — instrumentation for
        // tools/gs-measure-verify.js to assert zoom never refines.
        this._refineCount = 0;
        // Source of the last _resolve result: "mesh" | "splat" | "none".
        this._lastResolveSource = "none";

        // Gaussian-splat fallback: splats aren't depth-pickable, so when the mesh
        // depth pick misses we snap to the nearest splat centre instead.
        this._splatSource = options.getTilesets
            ? new SplatPivotSource({getTilesets: options.getTilesets})
            : null;

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

        // Per-frame memos so repeated same-pixel picks within a frame collapse to one
        // neighbourhood search (_memo) and one refine (_pivotMemo). Cleared each frame.
        // pivot-probe measured spin/tilt as one pick per gesture on a MESH tileset; splat
        // call frequency is unmeasured, so _pivotMemo bounds refine to once/frame regardless.
        this._memo = new Map();
        this._pivotMemo = new Map();
        this._frame = 0;
        scene.preRender.addEventListener(() => {
            this._frame++;
            this._memo.clear();
            this._pivotMemo.clear();
        });

        scene.pickPositionWorldCoordinates = (windowPosition, result) => {
            const pivot = this._pivotPoint(windowPosition);
            if (pivot) {
                return Cartesian3.clone(pivot, result);
            }
            return this._origPick(windowPosition, result);
        };
    }

    // The pivot point for the current gesture: the snapped hit, refined to full-density
    // splat precision for spin/tilt (but not zoom, and not mesh hits — mesh depth is
    // already exact). Used by both the pick shadow and the marker so they agree.
    _pivotPoint(windowPosition) {
        const snapped = this._resolve(windowPosition);
        if (!snapped) return undefined;
        if (
            this._splatSource &&
            this._lastResolveSource === "splat" &&
            (this._gesture === "spin" || this._gesture === "tilt")
        ) {
            const key = Math.round(windowPosition.x) + "," + Math.round(windowPosition.y);
            if (this._pivotMemo.has(key)) {
                return this._pivotMemo.get(key);
            }
            const refined = this._splatSource.refine(this._scene, snapped, PIVOT_REFINE_RADIUS_PX);
            const pivot = refined ? refined.aggregate : snapped;
            if (refined) this._refineCount++;
            this._pivotMemo.set(key, pivot);
            return pivot;
        }
        return snapped;
    }

    // Nearest-to-camera hit within SNAP_RADIUS_PX of windowPosition, or undefined. Records
    // whether the result came from the mesh depth ring or the splat fallback in
    // _lastResolveSource (so _pivotPoint only refines splat-derived pivots).
    _resolve(windowPosition) {
        const key = Math.round(windowPosition.x) + "," + Math.round(windowPosition.y);
        if (this._memo.has(key)) {
            const m = this._memo.get(key);
            this._lastResolveSource = m.src;
            return m.p;
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

        // Mesh depth pick found nothing — try the Gaussian-splat centre fallback.
        let src = best !== undefined ? "mesh" : "none";
        if (best === undefined && this._splatSource) {
            best = this._splatSource.query(this._scene, windowPosition, SPLAT_SNAP_RADIUS_PX);
            if (best !== undefined) src = "splat";
        }

        this._memo.set(key, {p: best, src});
        this._lastResolveSource = src;
        return best;
    }

    // --- rotation-centre marker ---------------------------------------------

    // A DOM overlay, NOT a Cesium billboard. A billboard renders in the TRANSLUCENT
    // pass (9), but Gaussian splats render later (GAUSSIAN_SPLATS pass 11) and paint
    // over it — the marker would be invisible on splats. A DOM element sits above the
    // canvas entirely, so it shows on mesh, splats, any content. While shown we project
    // the (fixed) world pivot to the screen each rendered frame, since the camera orbits
    // it during the drag.
    _installMarker() {
        const el = document.createElement("div");
        el.className = "rotation-center-marker";
        el.style.cssText =
            "position:absolute;width:40px;height:40px;margin:-20px 0 0 -20px;" +
            "pointer-events:none;display:none;z-index:1000;";
        el.innerHTML = MARKER_SVG;
        this._viewer.container.appendChild(el);
        this._markerEl = el;
        this._markerWorld = undefined;

        // Keep the marker glued to the world pivot as the camera orbits it.
        this._scene.postRender.addEventListener(() => {
            if (!this._markerWorld) return;
            const pos = this._scene.cartesianToCanvasCoordinates(this._markerWorld, scratchScreen);
            if (pos) {
                el.style.left = pos.x + "px";
                el.style.top = pos.y + "px";
                el.style.display = "block";
            } else {
                el.style.display = "none"; // pivot is behind the camera
            }
        });
    }

    _showMarkerAt(point) {
        this._markerWorld = Cartesian3.clone(point, this._markerWorld || new Cartesian3());
        const pos = this._scene.cartesianToCanvasCoordinates(this._markerWorld, scratchScreen);
        if (pos) {
            this._markerEl.style.left = pos.x + "px";
            this._markerEl.style.top = pos.y + "px";
            this._markerEl.style.display = "block";
        }
    }

    _hideMarker() {
        this._markerWorld = undefined;
        this._markerEl.style.display = "none";
    }

    // --- gesture wiring ------------------------------------------------------

    // The marker indicates the ROTATION centre, so it's bound to plain left-drag
    // (this app maps rotate -> LEFT_DRAG). The pivot Cesium will orbit comes from
    // the same _resolve() the wrap uses, so the marker and the orbit centre agree.
    _installGestureHandler() {
        this._handler = new ScreenSpaceEventHandler(this._scene.canvas);

        // Left-drag = spin, right-drag = tilt. Set the gesture BEFORE resolving the pivot
        // so _pivotPoint knows to refine. (Cesium's controller re-picks during the drag;
        // the gesture is already set by then.) The marker uses _pivotPoint too, so the
        // crosshair sits on the same refined point Cesium orbits.
        this._handler.setInputAction((event) => {
            this._gesture = "spin";
            if (this._isFlyActive() || this._isMeasureActive()) return;
            const point = this._pivotPoint(event.position);
            if (point) {
                this._showMarkerAt(point);
            }
        }, ScreenSpaceEventType.LEFT_DOWN);

        this._handler.setInputAction(() => {
            this._gesture = null;
            this._hideMarker();
        }, ScreenSpaceEventType.LEFT_UP);

        // Tilt (right-drag orbit) also refines its pivot, but shows no marker for now.
        this._handler.setInputAction(() => {
            this._gesture = "tilt";
        }, ScreenSpaceEventType.RIGHT_DOWN);

        this._handler.setInputAction(() => {
            this._gesture = null;
        }, ScreenSpaceEventType.RIGHT_UP);
    }

    // --- measurement resolution ---------------------------------------------

    // Resolve a precise world point at a pixel for measurement. Exact mesh depth hit if
    // the mesh is under the cursor (mesh depth is already per-pixel accurate); otherwise
    // the coarse decimated splat hit refined against the full-density splat centres.
    // Returns { point, source: 'mesh'|'splat', spread, count, ms } or undefined on a miss.
    resolveMeasurement(windowPosition) {
        const meshHit = this._origPick(windowPosition, new Cartesian3());
        if (meshHit) {
            return { point: meshHit, source: "mesh", spread: 0, count: 1, ms: 0 };
        }
        if (!this._splatSource) return undefined;

        const coarse = this._splatSource.query(this._scene, windowPosition, SPLAT_SNAP_RADIUS_PX);
        if (!coarse) return undefined;

        const refined = this._splatSource.refine(this._scene, coarse, MEASURE_REFINE_RADIUS_PX);
        if (!refined) {
            return { point: coarse, source: "splat", spread: 0, count: 0, ms: 0 };
        }
        return {
            point: refined.aggregate,
            source: "splat",
            spread: refined.spread,
            count: refined.count,
            ms: refined.ms,
        };
    }
}

const scratchSample = new Cartesian2();
const scratchHit = new Cartesian3();
const scratchScreen = new Cartesian2();

export { RotationCenterSnap };
