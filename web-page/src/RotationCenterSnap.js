import {
    Cartesian2,
    Cartesian3,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
} from "./CesiumJsInc.js";

import {SplatPivotSource} from "./SplatPivotSource.js";
import {pickTiered, ringSamplesFor} from "./pickTiers.js";

// Snaps the camera's rotate/tilt/zoom pivot to the nearest visible tileset point
// near the cursor, and shows a crosshair marker at the rotation centre.
//
// HOW: Cesium's ScreenSpaceCameraController derives every gesture pivot from
// scene.pickPositionWorldCoordinates (verified for 1.142 by tools/pivot-probe.js:
// rotate calls it 1x, tilt 1x, zoom 40-60x). We shadow that one instance method with a
// TIERED neighbourhood search (see pickTiers.js): try screen radii from small to large and
// stop at the first tier that hits, nearest-to-camera within a tier.
//
// The search is tuned on two axes — operation and tileset type — via PICK_POLICY below:
//   - Pivot is forgiving (tier 0 is a small ring so a closer surface just off the cursor
//     takes the rotation centre — the lattice-through-a-hole case).
//   - Measurement is precise (tier 0 is the exact pixel, so a direct hit on far geometry is
//     never stolen by a nearer thing a few px away; forgiveness only expands on a true miss).
//   - Gaussian splats use wider radii than mesh/point-cloud: the decimated splat centres are
//     sparser on screen than per-pixel depth, so the cursor needs a wider catch.
//
// A genuine miss (nothing in any tier) returns undefined, exactly as the stock method would:
// with the globe hidden there is no far-ellipsoid fallback, so the controller just rotates in
// place — benign.
//
// This wrap is intentionally the whole feature: snapping the pick snaps the pivot for rotate,
// tilt AND zoom at once, with no fork of Cesium's controller.

// Tier radii (px) by operation × tileset type. Ascending; tier 0 is the centre pixel (r=0)
// or a small ring (r>0). These are FEEL constants — tune by clicking, not by reasoning; the
// measure-mode hover preview (MeasureTool) makes a bad radius obvious before you commit.
const PICK_POLICY = {
    pivot:   {mesh: [5, 16], gs: [8, 28]},
    measure: {mesh: [0, 2, 5], gs: [4, 10, 20]},
};

// Ring sampling: aim for one depth read every RING_SPACING_PX around a ring, clamped. Scales
// so a 5px ring isn't oversampled and a 16px ring isn't so sparse it straddles thin geometry.
const RING_SPACING_PX = 5;
const MIN_RING_SAMPLES = 4;
const MAX_RING_SAMPLES = 20;
const ringSamples = (r) => ringSamplesFor(r, RING_SPACING_PX, MIN_RING_SAMPLES, MAX_RING_SAMPLES);

// Set true to log which (operation, source, tier) resolved each pick — handy while tuning
// PICK_POLICY. Off by default.
const DEBUG_PICK = false;

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
        // Source and tier of the last resolve — "mesh" | "splat" | "none", and the winning
        // tier index. Read by _pivotPoint (refine only splat pivots) and by the harness.
        this._lastResolveSource = "none";
        this._lastResolveTier = -1;

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

        // Per-frame memos so repeated same-pixel picks within a frame collapse to one tiered
        // search (_resolveMemo, keyed by operation+pixel) and one refine (_pivotMemo).
        // Cleared each frame. pivot-probe measured spin/tilt as one pick per gesture on a MESH
        // tileset; splat call frequency is unmeasured, so the memos bound cost to once/frame.
        this._resolveMemo = new Map();
        this._pivotMemo = new Map();
        this._frame = 0;
        scene.preRender.addEventListener(() => {
            this._frame++;
            this._resolveMemo.clear();
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
        const snapped = this._resolveTiered(windowPosition, "pivot");
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

    // Backward-compat alias used by the verification harnesses (tools/*.js): the pivot
    // resolve. Returns the point (undefined on a miss); source/tier land on the instance.
    _resolve(windowPosition) {
        return this._resolveTiered(windowPosition, "pivot");
    }

    // Tiered resolve for the given operation ("pivot" | "measure"). Mesh depth tiers first
    // (exact, preferred); on a full mesh miss, the Gaussian-splat tiers. Records the winning
    // source and tier on the instance; memoised per frame by operation+pixel.
    _resolveTiered(windowPosition, operation) {
        const key =
            operation + ":" + Math.round(windowPosition.x) + "," + Math.round(windowPosition.y);
        if (this._resolveMemo.has(key)) {
            const m = this._resolveMemo.get(key);
            this._lastResolveSource = m.src;
            this._lastResolveTier = m.tier;
            return m.p;
        }

        const policy = PICK_POLICY[operation];
        let point;
        let src = "none";
        let tier = -1;

        const mesh = this._depthTiers(windowPosition, policy.mesh);
        if (mesh) {
            point = mesh.point;
            src = "mesh";
            tier = mesh.tier;
        } else if (this._splatSource) {
            const gs = this._splatTiers(windowPosition, policy.gs);
            if (gs) {
                point = gs.point;
                src = "splat";
                tier = gs.tier;
            }
        }

        this._resolveMemo.set(key, {p: point, src, tier});
        this._lastResolveSource = src;
        this._lastResolveTier = tier;
        if (DEBUG_PICK) {
            // eslint-disable-next-line no-console
            console.log(`[pick] ${operation} src=${src} tier=${tier}`);
        }
        return point;
    }

    // Mesh/point-cloud depth tiers: sample the depth buffer at the tier radii, nearest-to-
    // camera within a tier, first tier with a hit wins. { point, tier } or undefined.
    _depthTiers(windowPosition, radii) {
        const camPos = this._scene.camera.positionWC;
        const sample = (x, y) => {
            scratchSample.x = x;
            scratchSample.y = y;
            const hit = this._origPick(scratchSample, scratchHit);
            if (!hit) return undefined;
            return {
                point: Cartesian3.clone(hit, new Cartesian3()),
                camDist: Cartesian3.distance(hit, camPos),
            };
        };
        return pickTiered(windowPosition.x, windowPosition.y, radii, sample, ringSamples);
    }

    // Gaussian-splat tiers: query() already returns the nearest-to-camera centre within a
    // screen radius, so the smallest tier radius that catches anything wins. { point, tier }.
    _splatTiers(windowPosition, radii) {
        for (let ti = 0; ti < radii.length; ti++) {
            const hit = this._splatSource.query(this._scene, windowPosition, radii[ti]);
            if (hit) return {point: hit, tier: ti};
        }
        return undefined;
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

    // The marker indicates the rotation centre for both orbit gestures: spin (left-drag)
    // and tilt (right-drag). The pivot comes from the same _pivotPoint() the pick wrap
    // uses, so the marker and the orbit centre agree.
    _installGestureHandler() {
        this._handler = new ScreenSpaceEventHandler(this._scene.canvas);

        this._handler.setInputAction(
            (event) => this._beginGesture("spin", event.position),
            ScreenSpaceEventType.LEFT_DOWN,
        );
        this._handler.setInputAction(() => this._endGesture(), ScreenSpaceEventType.LEFT_UP);

        this._handler.setInputAction(
            (event) => this._beginGesture("tilt", event.position),
            ScreenSpaceEventType.RIGHT_DOWN,
        );
        this._handler.setInputAction(() => this._endGesture(), ScreenSpaceEventType.RIGHT_UP);
    }

    // Set the gesture BEFORE resolving the pivot so _pivotPoint knows to refine (Cesium's
    // controller re-picks during the drag; the gesture is already set by then), then show
    // the crosshair on the resolved pivot.
    _beginGesture(name, position) {
        this._gesture = name;
        if (this._isFlyActive() || this._isMeasureActive()) return;
        const point = this._pivotPoint(position);
        if (point) {
            this._showMarkerAt(point);
        }
    }

    _endGesture() {
        this._gesture = null;
        this._hideMarker();
    }

    // --- measurement resolution ---------------------------------------------

    // Resolve a precise world point at a pixel for measurement, using the "measure" policy
    // (exact-pixel first, tight forgiveness — a direct hit is never stolen). A mesh depth hit
    // is returned as-is (already per-pixel accurate); a splat hit is refined against the
    // full-density splat centres for the ± spread.
    // Returns { point, source: 'mesh'|'splat', spread, count, ms } or undefined on a miss.
    resolveMeasurement(windowPosition) {
        const hit = this._resolveTiered(windowPosition, "measure");
        if (!hit) return undefined;

        if (this._lastResolveSource === "mesh") {
            return {point: Cartesian3.clone(hit, new Cartesian3()), source: "mesh", spread: 0, count: 1, ms: 0};
        }

        const refined = this._splatSource.refine(this._scene, hit, MEASURE_REFINE_RADIUS_PX);
        if (!refined) {
            return {point: hit, source: "splat", spread: 0, count: 0, ms: 0};
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
