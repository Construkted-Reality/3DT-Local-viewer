// ABOUTME: Pure tiered-pick core shared by pivot and measurement resolution. No Cesium
// ABOUTME: dependency, so it's unit-tested headlessly in pickTiers.test.mjs.
//
// A "tier" is a screen radius. We try tiers from smallest to largest and STOP at the first
// tier that catches anything — so a smaller radius always wins over a larger one. This is
// what lets the two operations differ purely by their radius list:
//
//   - Measurement wants "what you clicked wins": tier 0 is the exact pixel (radius 0), so a
//     direct hit is never overridden by a nearer thing a few px away. Forgiveness only kicks
//     in on a true miss, expanding outward.
//   - Pivot wants "which object do I mean": tier 0 is a small ring (e.g. 5px) so a closer
//     surface just off the cursor takes the pivot — the lattice-through-a-hole case.
//
// WITHIN a tier the tie-break is nearest-to-CAMERA (foreground preference): if two samples
// in the same ring hit, the one in front wins. Across tiers it's nearest-to-cursor (smaller
// radius first). The caller supplies the sampler, so the same core drives mesh depth picks
// and — via a different sampler — could drive anything else pixel-based.

// Try each tier radius in ascending order; return { point, tier } from the first tier with a
// hit, or undefined. tier 0 always samples the centre pixel; a tier with radius r>0 samples a
// ring of ringSamples(r) points at radius r. sample(x,y) returns { point, camDist } or a
// falsy value on a miss; within a tier the smallest camDist wins.
function pickTiered(cx, cy, radii, sample, ringSamples) {
    for (let ti = 0; ti < radii.length; ti++) {
        const r = radii[ti];
        let best;
        let bestCam = Number.POSITIVE_INFINITY;

        const consider = (x, y) => {
            const hit = sample(x, y);
            if (hit && hit.camDist < bestCam) {
                bestCam = hit.camDist;
                best = hit.point;
            }
        };

        // The centre pixel belongs to tier 0 only (higher tiers are pure rings expanding
        // outward — the centre was already tried).
        if (ti === 0) consider(cx, cy);
        if (r > 0) {
            const n = ringSamples(r);
            for (let i = 0; i < n; i++) {
                const a = (2 * Math.PI * i) / n;
                consider(cx + r * Math.cos(a), cy + r * Math.sin(a));
            }
        }

        if (best !== undefined) return {point: best, tier: ti};
    }
    return undefined;
}

// Sample count for a ring of radius r: roughly one sample every `spacing` px around the
// circumference, clamped. Scales so a 5px ring isn't oversampled and a wide ring isn't so
// sparse that samples straddle thin geometry.
function ringSamplesFor(r, spacing, min, max) {
    return Math.max(min, Math.min(max, Math.round((2 * Math.PI * r) / spacing)));
}

export {pickTiered, ringSamplesFor};
