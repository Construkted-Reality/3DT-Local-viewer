# Plan: GS two-pass refined picking + prototype measurements (local viewer)

*2026-07-09 · status: awaiting Adrian's review · target branch: `feature/gs-measure`*

## Goal

Validate, in the local viewer, the two mechanisms destined for the platform:

1. **Two-pass refined pick** — coarse hit from the decimated 40k set, refined against the
   full-density in-memory splat centres (local-frame linear scan, k-nearest aggregation).
2. **A minimal two-point distance measurement tool on GS** that uses the refined pick and
   reports a per-measurement uncertainty (the k-nearest spread) — the data that would power
   the platform's "GS measurements are approximate" disclaimer.

Everything gets benchmarked and verified headlessly; measured numbers are appended to the
platform handoff doc (`docs/handoff/2026-07-09-gs-picking-platform-handoff.md`) before it
goes to the platform agent. The GPU id+depth pre-pass is documented in the handoff but
**not** built here (CPU refine first; a stopwatch decides if more is ever needed).

## Hypotheses under test (scientific-method framing)

- **H1:** refine returns the true nearest full-density centre (validated against an
  independent brute-force scan) in ≤ a few ms at the test asset's 72k splats.
- **H2:** refined picks differ from decimated picks by a measurable distance (the number
  that justifies — or kills — the refine step for measurements).
- **H3:** two refined clicks reproduce a known centre-to-centre distance within the
  reported uncertainty.
- Bonus: first real timing for the existing per-frame `query()` (closes the
  "sub-millisecond (estimated)" gap in the handoff).

## Phase 0 — branch & housekeeping

- Create `feature/gs-measure` off `main`; commit the (currently untracked) handoff doc and
  this plan as the first commit.
- Locate the GS sample tileset used by `tools/gs-verify.js` (`GS_TILESET_DIR`, gitignored —
  search disk near the repo/sample dirs; ask Adrian only if not found).
- Rebuild `web-page/app.js` after every source change (`cd web-page && npx rollup -c`).

## Phase 1 — refine pass in `SplatPivotSource`

**File: `web-page/src/SplatPivotSource.js`** (extend; no new module — it already owns the
tileset set, staleness tracking, and opacity handling).

New method:

```js
// coarseWorld: Cartesian3 from the existing decimated query (or depth pick)
// radiusPx: screen radius to refine within (converted to meters at hit depth)
refine(scene, coarseWorld, radiusPx) => {
  nearest: Cartesian3,        // true nearest full-density centre
  aggregate: Cartesian3,      // opacity-weighted mean of k nearest (the measurement point)
  spread: Number,             // stddev (m) of k-nearest about aggregate — the ± value
  count: Number,              // candidates found in radius
  ms: Number                  // refine duration (performance.now)
} | undefined
```

Implementation notes:
- World radius = `radiusPx × metersPerPixel(camera, distance(camera, coarseWorld))`.
- Per tileset: cache `Matrix4.inverse(_rootTransform)` (invalidate alongside `_builtFrom`),
  transform `coarseWorld` into the local frame **once**, then scan the raw Float32
  `_positions` with plain subtract-square-compare — no per-point matrix multiply.
- Opacity filter identical to `_rebuild` (`MIN_OPACITY`, `_opacityScale`).
- k nearest via bounded insertion (k = 32, code constant like `SNAP_RADIUS_PX`).
- Aggregate = opacity-weighted mean per axis (median deferred — YAGNI unless the spread
  numbers say the mean is being skewed by outliers; noted for the report either way).
- Also add `performance.now()` timing to the existing `query()` (dev-only, cheap).

## Phase 2 — minimal measurement tool

**New file: `web-page/src/MeasureTool.js`** + one button in
`web-page/src/NavigationControlbar.js` (existing `newButton` pattern, like FLY/ORBIT) +
wiring in `TilesetViewer.js` (pass viewer + the `RotationCenterSnap`/`SplatPivotSource`
instances).

Behaviour:
- MEASURE button toggles the mode (mutually exclusive with FLY; orbit stays usable —
  measure consumes `LEFT_CLICK` only, so left-*drag* rotate is untouched).
- Click 1 → refined point A; click 2 → refined point B; display; next click starts a new
  measurement. Toggling the mode off clears it.
- Pick resolution per click: mesh depth pick first (same neighbourhood `_resolve` the pivot
  uses), splat coarse+refine when depth misses — so the tool works on mesh, point-cloud,
  and GS content with one code path.
- **Display is a DOM/SVG overlay** (endpoint dots, connecting line, floating label
  "12.34 m ± 0.05 m"), projected to screen each `postRender` exactly like the crosshair
  marker. NOT a polyline/billboard — splats render in a later pass and would paint over
  them (the known render-order trap).
- `scene.requestRender()` after every visible state change (requestRenderMode invariant);
  update the CLAUDE.md call-site list.
- No settings UI, no persistence, no multi-segment chains — this is a testbed for the pick,
  not a shipping measurement suite.

## Phase 3 — verification & benchmarks

**New file: `tools/gs-measure-verify.js`** (clone the `gs-verify.js` CDP harness shape;
same `GS_TILESET_DIR` convention, writes `tools/traces/`).

Checks, in order of what they prove:
1. **H1 / correctness by construction:** for a grid of coarse hits, `refine().nearest`
   equals an independent in-page brute-force scan over all `_positions`. Any mismatch fails.
2. **H2 / precision delta:** for the same grid, distance between the decimated pick and the
   refined aggregate — min/median/max in meters. This is the handoff's justification number.
3. **H3 / ground truth:** pick two splat centres directly from the arrays, synthesize
   clicks at their screen projections, assert the tool's reported distance matches the
   direct centre-to-centre distance within the reported ± spread.
4. **Timings:** rebuild ms, per-frame `query()` ms, `refine()` ms at the asset's splat
   count (and extrapolation note for 1M/10M).
5. **Regression:** run existing `tools/gs-verify.js` and `tools/verify-snap.js` — pivot
   snapping must be unaffected on both GS and mesh.
6. Screenshot of an on-screen measurement over splats (label + line visible).

Manual check (Adrian): load the GS tileset, take a few measurements, confirm feel.

## Phase 4 — docs & wrap-up

- `docs/reports/2026-07-XX-gs-measurement-refine.md` — contemporaneous report with the real
  numbers (H1–H3 outcomes, timings, surprises).
- Append measured results to the handoff doc's measurement section (replace the "being
  validated" status line).
- Update `CLAUDE.md` (requestRender call-site list, measure-tool note) and `README.md`
  (delegate README update to a subagent per standing rules).
- Conventional commits per phase on `feature/gs-measure`; merge to main after Adrian's
  review of the test results.

## Effort profile (Adrian's terms)

- **Files touched:** 4 source (`SplatPivotSource.js`, new `MeasureTool.js`,
  `NavigationControlbar.js`, `TilesetViewer.js`), 1 new tool, 3 docs.
- **Iteration risk:** low for Phase 1 (pure math, verified by brute-force comparison);
  medium for Phase 2 (overlay projection + input-mode interplay with orbit/fly — the kind
  of thing that takes a screenshot cycle or two); low for Phase 3 (harness pattern exists).
- **Testability:** high — every hypothesis has a headless pass/fail check plus one
  screenshot; Adrian's manual review is "click twice, read a number."

## Verification status (2026-07-09)

- **Phase 1 (refine): implemented + verified headlessly.** `web-page/src/SplatPivotSource.test.mjs`
  loads Cesium math in Node and passes 11 assertions — H1 (refine.nearest == independent
  brute-force nearest), the opacity-weighted aggregate, the spread, radius filtering, and
  floater exclusion. Run: `cd web-page/src && node SplatPivotSource.test.mjs`.
- **Phase 2 (measure tool): implemented, bundle builds clean, NOT yet run in the app.**
  No display/GPU in the build shell (no X server, no `xvfb`, no sample tilesets), so the
  overlay rendering, mesh-depth-pick path, and mode interplay are code-reviewed but not
  runtime-exercised here.
- **Phase 3 (app harness): written, NOT yet run.** `tools/gs-measure-verify.js` needs
  `GS_TILESET_DIR` + a display+GPU session (same as `gs-verify.js`).
- **Blocked on Adrian:** (1) path to a `KHR_gaussian_splatting` tileset; (2) a run of
  `GS_TILESET_DIR=… DISPLAY=:0 node_modules/.bin/electron tools/gs-measure-verify.js` (and
  `gs-verify.js` / `verify-snap.js` for regression) on a display machine. Real H1/H2/H3
  numbers + timings + screenshot get folded into a dated report and the handoff doc after
  that run.

## Explicit non-goals

- GPU id+depth offscreen pre-pass (documented in handoff only).
- Spatial index / grid hash (only if Phase 3 timings demand it — the data decides).
- Porting anything to the platform (the handoff doc + measured numbers are the deliverable).
- Resurrecting `CesiumMeasurementPlugin.js` (incompatible with current Cesium; untouched).
