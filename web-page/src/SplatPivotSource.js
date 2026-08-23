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
// k for the refine pass: the measurement point is the opacity-weighted mean of the k
// full-density centres nearest the coarse hit, and the spread of those k is the reported
// uncertainty. Small enough to stay local to the clicked feature.
const K_NEAREST = 32;

class SplatPivotSource {
    // options: { getTilesets: () => Array<Cesium3DTileset> }
    constructor(options) {
        this._getTilesets = options.getTilesets;
        this._centers = new Float64Array(0); // world-space xyz triples
        this._builtFrom = new Map();          // tileset -> _numSplats snapshot at last build
    }

    // Nearest splat center to the cursor (within radiusPx), nearest the camera. Or undefined.
    query(scene, windowPosition, radiusPx) {
        const t0 = performance.now();
        this._ensureFresh();
        const centers = this._centers;
        if (centers.length === 0) {
            this._lastQueryMs = performance.now() - t0;
            return undefined;
        }

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
        this._lastQueryMs = performance.now() - t0;
        return best;
    }

    // Refine a coarse world hit to full-density precision — the measurement path.
    //
    // The pivot query() above works off the decimated 40k set: fine for a rotation centre,
    // too coarse for a measurement. refine() instead reads the FULL-density centres Cesium
    // already holds in _positions. Those live in each tileset's local frame, so we transform
    // the (single) coarse hit into that frame once and scan the raw array with a plain 3D
    // distance test — no per-point matrix multiply, no projection. Only the handful of
    // survivors within the radius are transformed to world for the final maths.
    //
    // Returns { nearest, aggregate, spread, count, ms } or undefined:
    //   nearest   Cartesian3  true nearest full-density centre to the coarse hit
    //   aggregate Cartesian3  opacity-weighted mean of the k nearest — the measurement point
    //   spread    Number      weighted RMS distance (m) of the k nearest about aggregate — the ±
    //   count     Number      candidates found within the radius
    //   ms        Number      wall-clock of the scan
    //
    // This is a one-shot per-click cost (tens of ms even at millions of splats), not a
    // per-frame cost. See docs/plans/2026-07-09-gs-measurement-plan.md.
    refine(scene, coarseWorld, radiusPx) {
        const t0 = performance.now();
        const tilesets = (this._getTilesets() || []).filter(
            (t) => t && t.gaussianSplatPrimitive && t.gaussianSplatPrimitive._numSplats > 0,
        );
        if (tilesets.length === 0) return undefined;

        const worldRadius = this._worldRadius(scene, coarseWorld, radiusPx);

        // Survivors within the radius, in world space, tagged with distance² to the coarse
        // hit and an opacity weight. Collected across all splat tilesets.
        const survivors = [];
        for (const t of tilesets) {
            this._collectNearest(t, coarseWorld, worldRadius, survivors);
        }
        if (survivors.length === 0) return undefined;

        survivors.sort((a, b) => a.d2 - b.d2);
        const k = Math.min(K_NEAREST, survivors.length);

        const n0 = survivors[0];
        const nearest = new Cartesian3(n0.x, n0.y, n0.z);

        // Opacity-weighted mean of the k nearest → the measurement point. Averages out the
        // scatter of individual splat centres about the reconstructed surface.
        let wx = 0, wy = 0, wz = 0, wsum = 0;
        for (let i = 0; i < k; i++) {
            const s = survivors[i];
            wx += s.x * s.w; wy += s.y * s.w; wz += s.z * s.w; wsum += s.w;
        }
        const inv = wsum > 0 ? 1 / wsum : 0;
        const aggregate = new Cartesian3(wx * inv, wy * inv, wz * inv);

        // Weighted RMS distance of the k nearest about the aggregate → measurement uncertainty.
        let vsum = 0;
        for (let i = 0; i < k; i++) {
            const s = survivors[i];
            const dx = s.x - aggregate.x, dy = s.y - aggregate.y, dz = s.z - aggregate.z;
            vsum += s.w * (dx * dx + dy * dy + dz * dz);
        }
        const spread = wsum > 0 ? Math.sqrt(vsum * inv) : 0;

        return { nearest, aggregate, spread, count: survivors.length, ms: performance.now() - t0 };
    }

    // Scan one tileset's full-density centres and push survivors within worldRadius of
    // coarseWorld into `out`. The cheap distance filter runs in the tileset's local frame
    // (raw _positions, no per-point transform); only survivors are lifted to world.
    _collectNearest(t, coarseWorld, worldRadius, out) {
        const gsp = t.gaussianSplatPrimitive;
        const pos = gsp._positions;
        const colors = gsp._colors;
        const rt = gsp._rootTransform;
        const n = gsp._numSplats;
        const colorScale = this._opacityScale(colors, n);

        // Query point in the local frame; scan there, report world.
        Matrix4.inverse(rt, scratchInv);
        Matrix4.multiplyByPoint(scratchInv, coarseWorld, scratchQLocal);
        // Uniform-scale assumption (georef root transforms are rigid or uniformly scaled):
        // convert the world radius into the local frame so the filter threshold is correct.
        Matrix4.getScale(rt, scratchScale);
        const s = scratchScale.x || 1;
        const localR = worldRadius / s;
        const localR2 = localR * localR;

        const qx = scratchQLocal.x, qy = scratchQLocal.y, qz = scratchQLocal.z;
        for (let i = 0; i < n; i++) {
            const lx = pos[i * 3], ly = pos[i * 3 + 1], lz = pos[i * 3 + 2];
            const dx = lx - qx, dy = ly - qy, dz = lz - qz;
            if (dx * dx + dy * dy + dz * dz > localR2) continue;
            let w = 1;
            if (colorScale > 0) {
                w = colors[i * 4 + 3] * colorScale;
                if (w < MIN_OPACITY) continue; // floater
            }
            scratchLocal.x = lx; scratchLocal.y = ly; scratchLocal.z = lz;
            Matrix4.multiplyByPoint(rt, scratchLocal, scratchWorld);
            const wdx = scratchWorld.x - coarseWorld.x;
            const wdy = scratchWorld.y - coarseWorld.y;
            const wdz = scratchWorld.z - coarseWorld.z;
            out.push({
                x: scratchWorld.x, y: scratchWorld.y, z: scratchWorld.z,
                w: w,
                d2: wdx * wdx + wdy * wdy + wdz * wdz,
            });
        }
    }

    // World-space radius corresponding to radiusPx screen pixels at the hit's depth.
    _worldRadius(scene, worldPoint, radiusPx) {
        const camera = scene.camera;
        const distance = Cartesian3.distance(camera.positionWC, worldPoint);
        const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight;
        const pr = scene.pixelRatio || 1;
        try {
            const dims = camera.frustum.getPixelDimensions(w, h, distance, pr, scratchPixel);
            return Math.max(dims.x, dims.y) * radiusPx;
        } catch (e) {
            // Fallback for non-perspective frustums: ~2·d·tan(fovy/2)/h per pixel.
            const fovy = camera.frustum.fovy || 1.0;
            return ((2 * distance * Math.tan(fovy / 2)) / h) * radiusPx * pr;
        }
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
const scratchInv = new Matrix4();
const scratchQLocal = new Cartesian3();
const scratchScale = new Cartesian3();
const scratchPixel = new Cartesian2();

export { SplatPivotSource };
