// ABOUTME: Headless unit test for SplatPivotSource.refine — the full-density measurement
// ABOUTME: pick. Loads Cesium math in Node, stubs a scene/tileset. Run:
// ABOUTME:   node src/SplatPivotSource.test.mjs   (exits non-zero on failure)
//
// Validates H1 (refine.nearest == an independent brute-force nearest over all centres),
// the opacity-weighted aggregate, the spread, radius filtering, and floater exclusion —
// no GPU, no renderer, no GS tileset needed. The end-to-end app checks live in
// tools/gs-measure-verify.js (needs a real splat tileset).

import {createRequire} from "module";
const require = createRequire(import.meta.url);
const Cesium = require("../Cesium-1.142/Build/Cesium/index.js");
globalThis.Cesium = Cesium;
const {Cartesian3, Matrix3, Matrix4, Math: CMath} = Cesium;

const {SplatPivotSource} = await import("./SplatPivotSource.js");

let failures = 0;
function check(name, cond, extra) {
    if (cond) {
        console.log(`ok   - ${name}`);
    } else {
        console.error(`FAIL - ${name}${extra ? " :: " + extra : ""}`);
        failures++;
    }
}
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// --- fixtures ---------------------------------------------------------------

// Rigid (uniform-scale) root transform: rotate 30° about Z, translate to an ECEF-like
// offset. Exercises the local-frame scan + world-space reporting round trip.
const rot = Matrix3.fromRotationZ(CMath.toRadians(30), new Matrix3());
const trans = new Cartesian3(1_000_000, 2_000_000, 3_000_000);
const rt = Matrix4.fromRotationTranslation(rot, trans, new Matrix4());

// Local-frame centres: a tight cluster near the local origin plus one far outlier.
const localPts = [
    [0.0, 0.0, 0.0],
    [0.1, 0.0, 0.0],
    [0.0, 0.1, 0.0],
    [0.05, 0.05, 0.0],
    [5.0, 5.0, 5.0], // outlier — must fall outside the radius
];

function buildTileset(opacities) {
    const n = localPts.length;
    const positions = new Float32Array(n * 3);
    const colors = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        positions[i * 3] = localPts[i][0];
        positions[i * 3 + 1] = localPts[i][1];
        positions[i * 3 + 2] = localPts[i][2];
        colors[i * 4] = 255;
        colors[i * 4 + 1] = 255;
        colors[i * 4 + 2] = 255;
        colors[i * 4 + 3] = opacities[i];
    }
    return {
        gaussianSplatPrimitive: {
            _positions: positions,
            _colors: colors,
            _numSplats: n,
            _rootTransform: rt,
        },
    };
}

// Stub scene: fixed metres-per-pixel so worldRadius = MPP * radiusPx is exactly known.
const MPP = 0.02;
const scene = {
    drawingBufferWidth: 1000,
    drawingBufferHeight: 800,
    pixelRatio: 1,
    camera: {
        positionWC: new Cartesian3(0, 0, 0),
        frustum: {
            getPixelDimensions: (w, h, d, pr, res) => {
                res.x = MPP;
                res.y = MPP;
                return res;
            },
        },
    },
};

const worldOf = (lp) => Matrix4.multiplyByPoint(rt, new Cartesian3(lp[0], lp[1], lp[2]), new Cartesian3());

// --- H1 + aggregate + spread ------------------------------------------------

{
    const src = new SplatPivotSource({getTilesets: () => [buildTileset([255, 255, 255, 255, 255])]});

    // Coarse hit: world position of cluster point [0.05,0.05,0] nudged by 1cm.
    const target = worldOf([0.05, 0.05, 0.0]);
    const coarse = Cartesian3.add(target, new Cartesian3(0.01, 0.0, 0.0), new Cartesian3());

    const radiusPx = 40; // worldRadius = 0.8 m: catches the 4 cluster pts, excludes the outlier
    const res = src.refine(scene, coarse, radiusPx);

    check("refine returns a result", !!res);

    // Independent brute-force nearest over ALL centres (world space).
    let bfIdx = -1, bfBest = Infinity;
    for (let i = 0; i < localPts.length; i++) {
        const d = Cartesian3.distance(worldOf(localPts[i]), coarse);
        if (d < bfBest) { bfBest = d; bfIdx = i; }
    }
    const bfNearest = worldOf(localPts[bfIdx]);
    check(
        "H1: refine.nearest == brute-force nearest",
        approx(Cartesian3.distance(res.nearest, bfNearest), 0, 1e-3),
        `got ${JSON.stringify(res.nearest)} want ${JSON.stringify(bfNearest)}`,
    );

    check("outlier excluded by radius (count === 4)", res.count === 4, `count=${res.count}`);

    // Equal weights → aggregate is the centroid of the 4 cluster centres.
    const cx = (worldOf(localPts[0]).x + worldOf(localPts[1]).x + worldOf(localPts[2]).x + worldOf(localPts[3]).x) / 4;
    const cy = (worldOf(localPts[0]).y + worldOf(localPts[1]).y + worldOf(localPts[2]).y + worldOf(localPts[3]).y) / 4;
    const cz = (worldOf(localPts[0]).z + worldOf(localPts[1]).z + worldOf(localPts[2]).z + worldOf(localPts[3]).z) / 4;
    check(
        "aggregate == centroid of cluster (equal opacity)",
        approx(res.aggregate.x, cx, 1e-2) && approx(res.aggregate.y, cy, 1e-2) && approx(res.aggregate.z, cz, 1e-2),
        `got ${JSON.stringify(res.aggregate)}`,
    );

    // Spread == RMS distance of the 4 cluster centres about the centroid.
    let sum = 0;
    for (let i = 0; i < 4; i++) {
        const w = worldOf(localPts[i]);
        const dx = w.x - cx, dy = w.y - cy, dz = w.z - cz;
        sum += dx * dx + dy * dy + dz * dz;
    }
    const rms = Math.sqrt(sum / 4);
    check("spread == RMS about aggregate", approx(res.spread, rms, 1e-3), `got ${res.spread} want ${rms}`);
    check("spread is positive for a scattered cluster", res.spread > 0);
    check("timing recorded (ms >= 0)", typeof res.ms === "number" && res.ms >= 0);
}

// --- radius too small: only the exact hit survives ---------------------------

{
    const src = new SplatPivotSource({getTilesets: () => [buildTileset([255, 255, 255, 255, 255])]});
    const coarse = worldOf([0.0, 0.0, 0.0]); // exactly on a centre
    const res = src.refine(scene, coarse, 1); // worldRadius = 0.02 m: only the coincident point
    check("tiny radius catches exactly the coincident centre", res && res.count === 1, `count=${res && res.count}`);
}

// --- floater exclusion -------------------------------------------------------

{
    // Drop [0.05,0.05,0] below MIN_OPACITY (0.15*255≈38): opacity 10 → excluded.
    const src = new SplatPivotSource({getTilesets: () => [buildTileset([255, 255, 255, 10, 255])]});
    const target = worldOf([0.05, 0.05, 0.0]);
    const coarse = Cartesian3.add(target, new Cartesian3(0.01, 0.0, 0.0), new Cartesian3());
    const res = src.refine(scene, coarse, 40);
    check("floater excluded (count === 3)", res && res.count === 3, `count=${res && res.count}`);
    // Nearest must not be the floater centre.
    const floaterWorld = worldOf([0.05, 0.05, 0.0]);
    check(
        "nearest is not the excluded floater",
        res && Cartesian3.distance(res.nearest, floaterWorld) > 1e-3,
    );
}

// --- empty / no-splat tileset ------------------------------------------------

{
    const src = new SplatPivotSource({getTilesets: () => []});
    const res = src.refine(scene, new Cartesian3(1, 2, 3), 40);
    check("no tilesets → undefined", res === undefined);
}

console.log(failures === 0 ? "\nall tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
