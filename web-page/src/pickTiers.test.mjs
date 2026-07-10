// ABOUTME: Headless unit test for the pure tiered-pick core (pickTiers.js). Run:
// ABOUTME:   node src/pickTiers.test.mjs   (exits non-zero on failure)
//
// Proves the two behaviours the two-axis design hinges on:
//   - measurement (tier 0 = exact pixel): a direct hit on FAR geometry is NOT stolen by a
//     nearer thing a few px away;
//   - pivot (tier 0 = small ring): a closer surface just off the cursor DOES take the pivot
//     (foreground preference), and outer tiers still forgive a true miss.

import {pickTiered, ringSamplesFor} from "./pickTiers.js";

let failures = 0;
function check(name, cond, extra) {
    if (cond) console.log(`ok   - ${name}`);
    else { console.error(`FAIL - ${name}${extra ? " :: " + extra : ""}`); failures++; }
}

// A mock world: named geometry points at screen positions, each with a camera distance.
// sample(x,y) hits a geom point if within HIT_TOL px of it.
const HIT_TOL = 1.5;
function makeSampler(geom) {
    return (x, y) => {
        for (const g of geom) {
            if (Math.hypot(x - g.x, y - g.y) <= HIT_TOL) {
                return {point: g.name, camDist: g.camDist};
            }
        }
        return undefined;
    };
}
const rs = (r) => ringSamplesFor(r, 5, 4, 20);

const MEASURE = [0, 2, 5];
const PIVOT = [5, 16];

// --- measurement: exact hit on far geometry is not stolen --------------------
{
    // FAR under the cursor (camDist 100), NEAR 5px away (camDist 10).
    const geom = [
        {name: "far", x: 0, y: 0, camDist: 100},
        {name: "near", x: 5, y: 0, camDist: 10},
    ];
    const res = pickTiered(0, 0, MEASURE, makeSampler(geom), rs);
    check("measure: direct far hit wins (not stolen by near)", res && res.point === "far" && res.tier === 0,
        JSON.stringify(res));
}

// --- pivot: same geometry, near just off the cursor takes the pivot ----------
{
    const geom = [
        {name: "far", x: 0, y: 0, camDist: 100},
        {name: "near", x: 5, y: 0, camDist: 10},
    ];
    const res = pickTiered(0, 0, PIVOT, makeSampler(geom), rs);
    check("pivot: near (5px, foreground) beats far under cursor", res && res.point === "near" && res.tier === 0,
        JSON.stringify(res));
}

// --- measurement: true miss at cursor forgives outward ----------------------
{
    // Nothing under the cursor; only NEAR at 5px. Measure should still find it at tier 2.
    const geom = [{name: "near", x: 5, y: 0, camDist: 10}];
    const res = pickTiered(0, 0, MEASURE, makeSampler(geom), rs);
    check("measure: true miss forgives outward to 5px tier", res && res.point === "near" && res.tier === 2,
        JSON.stringify(res));
}

// --- pivot: nothing near, geometry only at outer ring forgives --------------
{
    const geom = [{name: "edge", x: 16, y: 0, camDist: 50}];
    const res = pickTiered(0, 0, PIVOT, makeSampler(geom), rs);
    check("pivot: outer 16px tier forgives a near-edge miss", res && res.point === "edge" && res.tier === 1,
        JSON.stringify(res));
}

// --- complete miss ----------------------------------------------------------
{
    const res = pickTiered(0, 0, MEASURE, makeSampler([]), rs);
    check("complete miss → undefined", res === undefined);
}

// --- within-tier tie-break is nearest-to-camera -----------------------------
{
    // Two hits on the same 5px ring: near (camDist 10) and far (camDist 100). Near wins.
    const geom = [
        {name: "ringNear", x: 5, y: 0, camDist: 10},
        {name: "ringFar", x: -5, y: 0, camDist: 100},
    ];
    const res = pickTiered(0, 0, [5], makeSampler(geom), rs);
    check("within-tier tie-break picks nearest-to-camera", res && res.point === "ringNear", JSON.stringify(res));
}

// --- ringSamplesFor scaling -------------------------------------------------
check("ringSamplesFor clamps small radii to min", ringSamplesFor(1, 5, 4, 20) === 4);
check("ringSamplesFor scales mid radii", ringSamplesFor(16, 5, 4, 20) === 20 || ringSamplesFor(16, 5, 4, 20) >= 18);
check("ringSamplesFor clamps large radii to max", ringSamplesFor(100, 5, 4, 20) === 20);

console.log(failures === 0 ? "\nall tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
