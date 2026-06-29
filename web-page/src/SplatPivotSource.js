import {
    Cartesian2,
    Cartesian3,
    Matrix4,
} from "./CesiumJsInc.js";

// Pivot snapping for Gaussian-splat tilesets.
//
// Splats render but are NOT pickable in Cesium 1.142 — pickPositionWorldCoordinates
// and scene.pick both return nothing (they write no depth, carry no pick id; upstream
// issue CesiumGS/cesium#13326). So the mesh depth-pick path in RotationCenterSnap finds
// nothing on splats. We recover a pivot from the SPLAT CENTERS instead.
//
// Cesium aggregates every loaded tile's splats into tileset.gaussianSplatPrimitive with
// live typed arrays: _positions (Float32 xyz, in the _rootTransform frame), _colors
// (rgba, alpha = opacity), _scales, _numSplats. We read those, drop floaters, decimate
// to a capped world-space point set, and answer "nearest center to the cursor" — taking
// the center NEAREST THE CAMERA among those projecting within a screen radius of the
// cursor. Nearest-to-camera gives the same foreground preference as the mesh path (a
// near lattice member beats the far background seen through a gap).
//
// We considered an invisible depth-writing point overlay so the existing pick wrap would
// "just work": it does pick, but opaque depth points occlude the translucent splats
// (black holes in the render), so this CPU query is the chosen mechanism. It also touches
// the render not at all. Coupling: the private _positions/_rootTransform field names must
// be re-verified on each Cesium upgrade (see tools/pivot-probe.js / gs-snap-test.js).

// Max centers we keep after filtering; splats are decimated to this by striding. ~40k
// projections per resolve is sub-millisecond and memoised per frame by the caller.
const MAX_CENTERS = 40000;
// Opacity below this is treated as a floater and excluded (alpha normalised to 0..1).
const MIN_OPACITY = 0.15;

class SplatPivotSource {
    // options: { getTilesets: () => Array<Cesium3DTileset> }
    constructor(options) {
        this._getTilesets = options.getTilesets;
        this._centers = new Float64Array(0); // world-space xyz triples
        this._builtFrom = new Map();          // tileset -> _numSplats snapshot at last build
    }

    // Nearest splat center to the cursor (within radiusPx), nearest the camera. Or undefined.
    query(scene, windowPosition, radiusPx) {
        this._ensureFresh();
        const centers = this._centers;
        if (centers.length === 0) return undefined;

        const camPos = scene.camera.positionWC;
        const r2 = radiusPx * radiusPx;
        let best;
        let bestCamDist = Number.POSITIVE_INFINITY;

        for (let i = 0; i < centers.length; i += 3) {
            scratchWorld.x = centers[i];
            scratchWorld.y = centers[i + 1];
            scratchWorld.z = centers[i + 2];
            // cartesianToCanvasCoordinates returns undefined for points behind the camera.
            const screen = scene.cartesianToCanvasCoordinates(scratchWorld, scratchScreen);
            if (!screen) continue;
            const dx = screen.x - windowPosition.x;
            const dy = screen.y - windowPosition.y;
            if (dx * dx + dy * dy > r2) continue;
            const camDist = Cartesian3.distanceSquared(scratchWorld, camPos);
            if (camDist < bestCamDist) {
                bestCamDist = camDist;
                best = Cartesian3.clone(scratchWorld, best === undefined ? new Cartesian3() : best);
            }
        }
        return best;
    }

    // Rebuild the center set if any tileset's splat count changed since last build.
    _ensureFresh() {
        const tilesets = (this._getTilesets() || []).filter(
            (t) => t && t.gaussianSplatPrimitive && t.gaussianSplatPrimitive._numSplats > 0,
        );

        let stale = tilesets.length !== this._builtFrom.size;
        for (const t of tilesets) {
            if (this._builtFrom.get(t) !== t.gaussianSplatPrimitive._numSplats) {
                stale = true;
                break;
            }
        }
        if (!stale) return;

        this._rebuild(tilesets);
    }

    _rebuild(tilesets) {
        // Total splats across tilesets, then a stride so the kept set is <= MAX_CENTERS.
        let total = 0;
        for (const t of tilesets) total += t.gaussianSplatPrimitive._numSplats;
        const stride = Math.max(1, Math.ceil(total / MAX_CENTERS));

        const out = [];
        this._builtFrom = new Map();
        for (const t of tilesets) {
            const gsp = t.gaussianSplatPrimitive;
            this._builtFrom.set(t, gsp._numSplats);
            const pos = gsp._positions;
            const colors = gsp._colors;
            const rt = gsp._rootTransform;
            const n = gsp._numSplats;
            // colors may be Uint8 (0..255) or float (0..1); detect once per tileset.
            const colorScale = this._opacityScale(colors, n);

            for (let i = 0; i < n; i += stride) {
                if (colorScale > 0) {
                    const a = colors[i * 4 + 3] * colorScale;
                    if (a < MIN_OPACITY) continue; // skip floaters
                }
                scratchLocal.x = pos[i * 3];
                scratchLocal.y = pos[i * 3 + 1];
                scratchLocal.z = pos[i * 3 + 2];
                Matrix4.multiplyByPoint(rt, scratchLocal, scratchWorld);
                out.push(scratchWorld.x, scratchWorld.y, scratchWorld.z);
            }
        }
        this._centers = new Float64Array(out);
    }

    // Returns the multiplier to map a color component to 0..1, or 0 if colors unusable.
    _opacityScale(colors, n) {
        if (!colors || colors.length < n * 4) return 0;
        if (colors instanceof Uint8Array || colors instanceof Uint8ClampedArray) return 1 / 255;
        return 1; // assume already 0..1
    }
}

const scratchLocal = new Cartesian3();
const scratchWorld = new Cartesian3();
const scratchScreen = new Cartesian2();

export { SplatPivotSource };
