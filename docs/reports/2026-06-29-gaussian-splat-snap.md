# Snapping on Gaussian splats — and the crosshair that vanished

*2026-06-29 · feature/rotation-center-snap · commit 93829f8*

This is the sequel to [the mesh rotation-snap story](2026-06-29-rotation-center-snap-mesh.md).
The mesh feature worked by shadowing `scene.pickPositionWorldCoordinates` and snapping the
pivot to the nearest depth hit. Then came the question: **does it work on Gaussian-splat
tilesets?**

## The honest answer was "I don't know" — so we measured

Rather than guess, we pointed the probe at a real `KHR_gaussian_splatting` tileset
(SPZ-compressed, 72,419 splats). The result was unambiguous and a little brutal: across a
558-point grid over visibly-rendered splats, **every pick method returned zero** — depth
pick, `scene.pickPosition`, and even `scene.pick` (primitive pick). Splats render but are
*not pickable* in Cesium 1.142.

This isn't a bug we could toggle off. Cesium's own tracking issue (CesiumGS/cesium#13326,
"Picking for Gaussian splats") says it plainly: splats are rendered back-to-front with
alpha blending, they write no conventional depth, and they carry no per-primitive pick id.
There is no decided implementation upstream. So the mesh hook — which reads the depth
buffer — finds nothing, and the feature simply no-ops on splats.

Adrian's requirement was blunt: *needed today, not later.* So we fanned out three agents
in parallel — web research on how other splat software picks a point, a Cesium-internals
exploration of what splat data we can actually reach at runtime, and a design brainstorm —
and synthesised.

## What the research found

- **Production splat viewers all *added* a picking path.** PlayCanvas/SuperSplat does a
  GPU id+depth pre-pass (writing per-splat-centre depth); three.js GaussianSplats3D does a
  CPU ray-vs-splat-tree; the research tooling renders a "median-transmittance" depth in the
  shader. Everyone converges on one thing for a *pivot*: **snapping to a nearby splat
  centre is plenty accurate.**
- **The splat centres are readable at runtime.** The Cesium exploration probe found that
  Cesium aggregates every loaded tile's splats into `tileset.gaussianSplatPrimitive`, with
  live typed arrays — `_positions` (xyz), `_scales`, `_colors` (rgba, alpha = opacity) —
  in the `_rootTransform` frame. World position = `_rootTransform × local`; 200/200 sampled
  centres projected correctly onto the rendered splats. Crucially, this means **we don't
  need to modify the splat generator** — it works on any splat tileset, including
  third-party ones.

## Two candidate mechanisms — and a test instead of a debate

The brainstorm produced two viable designs, and Adrian made the right call: *build the
risky bit of both and pick by behaviour, not theory.*

**Mechanism A — invisible depth overlay.** Place points at the splat centres that write
depth but paint nothing, so the *existing* mesh wrap snaps to them with zero new code. The
elegant trick: not transparent points (those go to the translucent pass and write no
depth), but **opaque points with `colorMask` all-false and `depthMask` true**. A spike
nailed the recipe in three iterations — including discovering that a custom Cesium
`Appearance` defaults to `translucent: true` (so it renders in the wrong pass) and that its
vertex shader must declare `in float batchId;` or the whole scene fails to compile. With
those fixed, depth-pick hits over the splats jumped from **0 to 180**. It worked.

…and then the screenshot killed it. The invisible depth points **punch black holes into
the splat cloud.** Opaque geometry that writes depth at the splat surface occludes the
translucent splats behind it — and the points need to be *fat* for pick coverage, so the
holes are big. This is inherent to "writes depth, sits in front," not a tuning problem.
The test disqualified Mechanism A before we ever wrote production code for it. (This is the
whole value of "measure, don't theorise" — the brainstorm had rated A the cleanest option;
the pixels disagreed.)

**Mechanism B — runtime centre query.** Read the splat centres into a decimated,
floater-filtered, world-space set; when the mesh depth-pick ring misses, return the centre
**nearest the camera within a screen radius of the cursor**. It touches the render not at
all — no holes possible. And "nearest to camera within a screen radius" is the same
foreground-preference that makes the mesh lattice-through-hole case work. This shipped:
`SplatPivotSource.js`. Verified against the real tileset — `_resolve` now hits 309/1560
grid points over the splats, the camera orbits the splat pivot, no holes, no crash.

## The crosshair that vanished

With snapping working, one thing was still wrong: on splats, **the marker was invisible.**
It showed fine on mesh. The functional checks passed (`marker.show === true`), so it was
*there* — just not on screen.

The cause was render order. Cesium renders in passes, and a quick grep of the (minified)
Pass enum gave the order outright:

```
OPAQUE:8 → TRANSLUCENT:9 → VOXELS:10 → GAUSSIAN_SPLATS:11 → … OVERLAY:13
```

A Cesium billboard entity — which is what the marker was — renders in **TRANSLUCENT (9)**.
Gaussian splats render in **GAUSSIAN_SPLATS (11)**, *after* it. So on a splat scene the
splat pass paints right over the billboard. On mesh (opaque/3D-tile passes, earlier) the
billboard sat on top, which is why it had always looked fine. The marker wasn't broken; it
was being buried by a later pass.

The fix sidesteps Cesium's passes entirely: **make the marker a DOM overlay.** An HTML
element in the viewer container sits above the WebGL canvas no matter what Cesium draws.
While a left-drag is active we project the (fixed) world pivot to screen coordinates each
`postRender` — the camera orbits the pivot, so its screen position moves — and we gave the
crosshair a dark halo so it reads on bright, over-exposed splat backgrounds. Now it's
visible on mesh and splats alike, confirmed by screenshot: a red-dot crosshair sitting dead
centre on the splat cloud.

## What shipped

- `SplatPivotSource.js`: nearest-splat-centre fallback (decimated to a capped set, floaters
  dropped by opacity, nearest-to-camera within `SPLAT_SNAP_RADIUS_PX`). Cost is bounded
  regardless of splat count.
- `RotationCenterSnap.js`: marker converted from a Cesium billboard to a DOM overlay, so it
  renders above splats; dark halo for contrast.
- Verified by `tools/gs-verify.js` against a real splat tileset (set `GS_TILESET_DIR`):
  snap resolves, marker visible, camera orbits, no render artifacts, no crash.

## Lessons

1. **Measure feasibility before designing.** Splats not being pickable at all was a
   surprise that reframed the whole task; a 0/558 grid scan settled it in minutes.
2. **Let the pixels vote.** The "obviously cleanest" mechanism (invisible depth overlay)
   was disqualified by a screenshot, not an argument. Building the risky bit of both
   candidates was cheaper than debating which would look right.
3. **"It's true but invisible" is a render-order bug.** When state says shown but the
   screen says no, suspect pass ordering before logic — and when in doubt, climb out of the
   engine's passes entirely (a DOM overlay always wins the z-fight).

> Carried forward: `SplatPivotSource` reads Cesium's **private** `gaussianSplatPrimitive`
> fields (`_positions`, `_rootTransform`, …). Re-verify on every Cesium upgrade with
> `tools/gs-verify.js`. Related known issue: a mixed-SH-degree 3DGS orbit crash in 1.142.
