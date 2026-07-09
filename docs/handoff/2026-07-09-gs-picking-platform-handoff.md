# Handoff: Porting Gaussian-splat pivot picking to the Construkted Reality platform

*2026-07-09 · from `3DT-Local-viewer` (main @ v1.5.0, CesiumJS 1.142) · for the platform dev branch*

## Who this is for

You are an agent working on the main Construkted Reality platform (`construkted.js`),
preparing it for Gaussian-splat (GS) integration. This document hands off the
**GS pivot-picking** mechanism built and proven in the `3DT-Local-viewer` app so you can
port it and start working with GS content. It tells you exactly what code to take, what to
leave, where it plugs into a Cesium app, and every coupling risk that comes with it.

Read this first, then read the two source files it points at. Everything here is verified
against **CesiumJS 1.142** with a real `KHR_gaussian_splatting` (SPZ-compressed) tileset.

---

## TL;DR

- **The one file that matters: `web-page/src/SplatPivotSource.js`** (~135 lines, self-contained).
  It answers a single question: *"given the scene, a cursor pixel, and a radius, return the
  world-space point on the splat cloud to rotate around — or `undefined`."*
- GS content is **not depth-pickable in Cesium 1.142** (upstream `CesiumGS/cesium#13326`).
  `scene.pickPosition`, `scene.pickPositionWorldCoordinates`, and `scene.pick` all return
  nothing over splats. So the normal "pick the point under the cursor" pivot path finds
  nothing and the camera orbits a garbage point.
- The fix reads the **splat centres Cesium already holds in memory**
  (`tileset.gaussianSplatPrimitive._positions`), decimates them to a capped world-space set,
  drops low-opacity floaters, and returns the centre **nearest the camera** among those
  projecting within a screen radius of the cursor. It is a **pure CPU query — zero GPU cost,
  zero render changes, <1 MB RAM.**
- **The platform already forks Cesium's `ScreenSpaceCameraController` for mesh/globe snapping**
  (`enableSnap` / `snapOffset` / overridden `pickGlobe`). You most likely **do not need to
  port the mesh mechanism** — you need to insert the GS fallback at the point where your
  existing pivot pick returns a miss over splat content. See "Integration".

---

## Background: why GS needs a special path

In an orbit camera, left-drag rotates around a pivot that Cesium picks from whatever is
under the cursor on mouse-down. For **meshes and point clouds** that pivot comes from the
depth buffer (they write depth, so they're pickable). For **Gaussian splats it doesn't
exist**: splats are rendered back-to-front with alpha blending, write no conventional depth,
and carry no per-primitive pick id. This is not a toggle — it's the current state of Cesium
(tracking issue `CesiumGS/cesium#13326`, "Picking for Gaussian splats", no decided upstream
implementation as of 1.142).

We confirmed this empirically, not by reading docs: a 558-point grid scan over
visibly-rendered splats returned **0 hits** across depth pick, `pickPosition`, and `pick`.
So any pivot logic that relies on picking will silently no-op on splats and the camera will
swing around a far-away fallback point.

---

## The mechanism that shipped — and the one that didn't

Two candidate designs were built to the "risky bit" and decided **by behaviour, not
argument** (screenshots, not theory):

### Rejected — "invisible depth overlay" (do not resurrect without reading this)

Place opaque points at the splat centres with `colorMask` all-false and `depthMask` true,
so they write depth but paint nothing; the *existing* depth-pick then "just works." A spike
got it working (depth-pick hits over splats went 0 → 180). **Then it was killed by a
screenshot: the depth-writing points punch black holes into the splat cloud** — opaque
geometry that writes depth in front of translucent splats occludes them, and the points must
be *fat* for pick coverage, so the holes are big. This is inherent to "writes depth, sits in
front," not a tuning problem. **If you're tempted to try a GPU depth pre-pass on the
platform, this is the trap it walks into.** (A full GPU id+depth pre-pass like PlayCanvas/
SuperSplat is a different, heavier beast — viable, but far more than a pivot needs.)

### Shipped — "runtime centre query" (`SplatPivotSource.js`)

Read the splat centres into a decimated, floater-filtered, world-space set; when the primary
pick misses, return the centre **nearest the camera within a screen radius of the cursor**.
Touches the render **not at all** — no holes possible. "Nearest to camera within a screen
radius" is the same foreground-preference that makes the mesh case correct (a near lattice
member beats the far background seen through a gap). This is what you're porting.

---

## The portable core: `SplatPivotSource.js` API contract

The whole class is mechanism-agnostic and has **no dependency on this app's camera hook**.
It's a drop-in.

**Constructor**
```js
new SplatPivotSource({ getTilesets: () => Array<Cesium3DTileset> })
```
`getTilesets` returns the tilesets that may contain splats (in this app, the left/right
compare tilesets). Return whatever set of tilesets your platform has loaded.

**Query (call this on pivot resolution)**
```js
// scene: Cesium.Scene
// windowPosition: Cesium.Cartesian2 (cursor pixel, canvas coords)
// radiusPx: screen radius to search (this app uses 28)
const worldPoint = splatSource.query(scene, windowPosition, radiusPx);
// => Cesium.Cartesian3 (world-space pivot) or undefined (no splat near cursor)
```

**Cesium symbols it needs** (import from your Cesium however the platform does it):
`Cartesian2`, `Cartesian3`, `Matrix4`.

**What it does internally** (read `SplatPivotSource.js` for the real thing):
- `_ensureFresh()` rebuilds the centre set only when any tileset's `_numSplats` changes
  (i.e. tiles streaming in/out) — **not per frame, not per query**.
- `_rebuild()` strides across all splats down to `MAX_CENTERS = 40000`, drops splats with
  normalised opacity `< MIN_OPACITY = 0.15` (floaters), and transforms survivors to world
  space via `Matrix4 × local`. Output is a `Float64Array` of xyz triples (~960 KB at cap).
- `query()` projects each kept centre to screen (`scene.cartesianToCanvasCoordinates`),
  keeps those within `radiusPx` of the cursor, and returns the one **nearest the camera**.

**Cost** (see "Performance" below): GPU zero, RAM <1 MB, CPU bounded to 40k iterations and
only while the user is actively dragging a splat scene.

---

## The private-field coupling (READ — this is the main maintenance risk)

`SplatPivotSource` reads **private, undocumented fields** off Cesium's aggregated splat
primitive. These are the exact names it depends on, verified for **1.142**:

| Field | Meaning |
|---|---|
| `tileset.gaussianSplatPrimitive` | Cesium aggregates every loaded tile's splats here |
| `.._positions` | `Float32` xyz, in the `_rootTransform` frame |
| `.._colors` | rgba; **alpha = opacity**. May be `Uint8` (0..255) or float (0..1) — detected per tileset |
| `.._scales` | per-splat scale (not currently used by the pivot query, but present) |
| `.._numSplats` | count; used as the staleness key for rebuilds |
| `.._rootTransform` | `Matrix4`; world position = `_rootTransform × local` |

**These names can change on any Cesium version bump.** Before trusting the port on a
different Cesium than 1.142, re-verify them (see "Verification"). If Cesium ships official
splat picking (`#13326`), prefer that and delete this — but until then this is the working
path, and it works on *any* splat tileset (including third-party) with no change to the
splat generator.

---

## Integration: where to plug it in on the platform

The platform's situation differs from this app in one decisive way, and it changes the port:

> **This app hides the globe** (`scene.globe.show = false`) and is pure 3D-Tiles, so its
> pivot comes from `scene.pickPositionWorldCoordinates` (tileset depth). It shadows that one
> instance method — a ~40-line hook, no Cesium fork (see `RotationCenterSnap.js`).
>
> **The platform (`construkted.js`) already forks `ScreenSpaceCameraController.js`** (~3100
> lines) and adds `enableSnap` / `snapOffset`, overriding the private `pickGlobe` with a
> 9-point grid that returns the hit nearest the camera. That fork already gives you
> mesh/globe pivot snapping.

So your job is **not** to re-implement snapping — it's to add the GS fallback at the seam
where your existing pivot pick comes back empty over splat content. Concretely:

1. **Find where your controller resolves the orbit/tilt/zoom pivot** — in your fork that's
   the overridden `pickGlobe` (and/or wherever you call `pickPosition` for the tileset
   depth path). This is the single point every gesture routes through.
2. **When that resolution misses** (returns nothing / falls back to the ellipsoid) **and the
   scene contains a GS tileset, call `SplatPivotSource.query(scene, cursorPx, radiusPx)`**
   and use its result as the pivot. If it also returns `undefined`, keep your current
   miss behaviour.
3. **Instantiate one `SplatPivotSource`** with a `getTilesets` that returns your loaded
   tilesets. It self-refreshes as tiles stream.
4. **Mind the coordinate space of `windowPosition`.** It must be **canvas pixel coords**.
   This app hit a real bug here: CDP/synthetic mouse events use viewport coords while the
   depth scan used canvas coords — a menu-bar offset made every click miss until converted
   through the canvas bounding rect. Make sure the cursor pixel you pass matches what
   `scene.cartesianToCanvasCoordinates` returns.

You do **not** need `RotationCenterSnap.js`'s pick-wrap for the platform — that's this app's
Cesium-fork-avoidance trick. You already have a fork; insert the fallback into it. Take
`RotationCenterSnap.js` as the **worked reference** for how the fallback is called and how
the marker is drawn, not as code to copy wholesale.

---

## The crosshair marker (optional to port, but read the render-order gotcha)

This app draws a white-crosshair-with-red-dot at the rotation centre during left-drag. If
you want the same on the platform, there is **one non-obvious constraint**:

> **The marker must NOT be a Cesium billboard/entity.** Billboards render in the
> `TRANSLUCENT` pass (9); Gaussian splats render later in `GAUSSIAN_SPLATS` (11) and paint
> right over them, so a billboard marker is **invisible on splats** (it works fine on mesh,
> which renders earlier — a trap that looks like it works until you test on splats).

The shipped solution: a **DOM overlay** (`RotationCenterSnap.js` `_installMarker`) — an HTML
element in the viewer container, above the WebGL canvas, so it shows over any content. While
a drag is active it projects the fixed world pivot to screen each `postRender` (the camera
orbits the pivot, so its screen position moves). The crosshair is an inline SVG data URI
(no image asset) drawn twice — a dark halo under a white stroke — so it reads on both dark
geometry and bright/over-exposed splat backgrounds. Copy `MARKER_SVG` and the
`_installMarker` / `_showMarkerAt` / `_hideMarker` pattern if you want it.

---

## Performance (what it costs)

- **GPU: zero.** No extra geometry, no draw calls, no VRAM. This was the deciding reason the
  centre-query beat the depth-overlay.
- **Memory: <1 MB.** `MAX_CENTERS = 40000` × 3 × `Float64` ≈ 960 KB, regardless of whether
  the tileset has 72k or 50M splats.
- **CPU rebuild:** one strided pass over all splats, **only when `_numSplats` changes**
  (tiles streaming). Bounded output at 40k.
- **CPU query:** up to 40k projections + distance tests, **only while actively dragging a
  splat scene**, and **memoised per frame by the caller** (a 40–60× zoom burst collapses to
  one search). Idle cost is zero — the query is gesture-gated.
- **Honesty flag:** the in-code note calls this "sub-millisecond," which is a reasonable
  estimate for 40k float ops but was **not directly benchmarked** — correctness was verified,
  timing was not. If you need a hard number on platform hardware, bracket `query()` with
  `performance.now()`.

---

## requestRenderMode caveat (applies if the platform uses it)

This app runs the Cesium `Viewer` with `requestRenderMode: true` +
`maximumRenderTimeChange: Infinity` (idle GPU/CPU ~92% lower). Under that mode **the scene
renders only when something requests a frame** — any custom interaction path (including the
marker projection and any pivot change you drive) must call `scene.requestRender()` or the
change won't show until the next organic render. If the platform does **not** use
`requestRenderMode`, ignore this. If it does, audit every place you move the camera or the
marker for a `requestRender()` call. `scene.preUpdate` / `postUpdate` listeners still fire
every animation frame regardless — do not put expensive work there.

---

## Verification: how to prove the port works

This app ships headless probes (Chrome DevTools Protocol driving the real renderer). Port or
adapt their *approach*; the exact harness is app-specific.

- **`tools/pivot-probe.js`** — wraps the pivot-pick method with a counter, dispatches real
  rotate/tilt/zoom gestures, reports which gesture calls the pick and how often, and whether
  the camera moved. **Run the platform equivalent on every Cesium upgrade** to confirm your
  controller still routes the pivot where you think it does.
- **`tools/gs-verify.js`** — points at a real splat tileset (`GS_TILESET_DIR` /
  `GS_TILESET_URL`), confirms the splat fallback resolves a pivot, the camera orbits it,
  the marker is visible, and there are no render artifacts or crashes. **This is the one to
  adapt for the platform** — it's the GS-specific acceptance test.
- Minimum bar to call the port good, from this app's verification: over a real splat cloud,
  the fallback resolves (this app hit 309/1560 grid points), the camera orbits the splat
  pivot, no black holes, marker visible on splats, no crash.

---

## Known issues / caveats carried forward

- **Splat picking is a moving target upstream.** `CesiumGS/cesium#13326`. If/when Cesium
  ships real splat picking, revisit — the private-field query becomes removable.
- **Private field names re-verify on every Cesium bump** (`_positions`, `_colors`,
  `_rootTransform`, `_numSplats`). This is the single most likely thing to break silently.
- **Mixed-SH-degree 3DGS orbit crash in 1.142** was observed — unrelated to picking but
  worth knowing when you load arbitrary splat assets to test.
- **Opacity units differ by asset:** `_colors` may be `Uint8` (0..255) or float (0..1);
  `SplatPivotSource._opacityScale` detects this per tileset. If your splats come through a
  different loader, sanity-check that the floater filter isn't dropping everything (empty
  centre set → query always `undefined` → no snap).

---

## Measurements on GS (design guidance — being validated in the local viewer)

> Status: **design, not shipped code.** The two-pass refine below is being implemented and
> benchmarked in `3DT-Local-viewer` first (smaller blast radius, faster iteration). Results
> and any corrections will be appended here before you build the platform version.

The platform will offer measurements on GS content. The pivot mechanism above is *not*
precise enough for that as-is — the 40k decimated set can return a centre some distance
from the clicked spot. But the fix is cheap, because **the full-density splat centres are
already in RAM** (`gaussianSplatPrimitive._positions`, Float32, every loaded splat) —
reading them costs no rendering, no GPU, nothing. The decimation exists only because the
*pivot* query runs every frame during a drag; a **measurement click is a one-shot event**
with a budget of tens of milliseconds.

### Two-pass refine (the recommended mechanism)

1. **Coarse pass:** resolve an approximate 3D hit with the existing machinery (decimated
   splat query, or the depth pick if mesh is also present).
2. **Refine pass:** transform that one point into the splat **local frame** (one
   `Matrix4.inverse(_rootTransform)`, computed once per tileset) and linearly scan the raw
   Float32 `_positions` with a plain 3D distance test — subtract, square, compare. No
   per-point matrix multiply, no projection: ~4 arithmetic ops per splat. Order tens of ms
   at 10M splats, once per click.
3. Return the true nearest splat centre within a world-space radius of the coarse hit —
   derive the radius from pixel size at the hit depth (e.g. `metersPerPixel × clickRadiusPx`),
   not a fixed constant.

Do **not** try to test "which full-density splats project within the screen-space click
radius" directly — that means projecting all N points (a matrix multiply each), which is the
expensive scan the two-pass structure exists to avoid.

If profiling shows the refine scan too slow on huge assets, the upgrade is a **uniform grid
hash over local coordinates** built once per rebuild (queries become ~O(1)). Ship the linear
refine first; let a stopwatch decide.

### Accuracy ceiling — and the disclaimer

**Splat centres are not the surface.** A splat is a fuzzy ellipsoid; the visible surface
emerges from thousands of overlapping blobs, and individual centres scatter around it with
spread on the order of the local splat scale. Even a perfect nearest-centre pick carries that
noise. Consequences for the platform:

- **Aggregate, don't trust one centre:** take the opacity-weighted median/mean of the
  k nearest centres around the coarse hit (use `_colors` alpha for weight; `_scales` is
  available too). This averages out the scatter and is a small extension of the refine pass.
- **Surface the uncertainty to the user.** The k-nearest spread (e.g. its standard deviation
  or the local median splat scale) is a per-click *measurement uncertainty estimate* you get
  for free from the refine pass. Displaying "12.34 m ± 0.05 m" — or at minimum a standing
  "measurements on Gaussian-splat content are approximate" disclaimer — is strongly
  recommended. Exact UX is an open product decision (Adrian's call), but the data to power
  it comes out of the same query.

### Production-grade option: GPU id+depth offscreen pre-pass

If measurement becomes a flagship feature and pixel-exact, occlusion-correct picking is
required, the ceiling is the approach production splat editors (PlayCanvas/SuperSplat) use:
render splat ids + centre depth to an **offscreen** target and read back the pixel under the
cursor. Critical distinction from the *rejected* mechanism above: the black-hole artifact
came from writing depth into the **main** render; an offscreen pick buffer never composites
to screen, so no visual artifacts are possible. Cost is one extra scene render per click
(not per frame) plus real engineering (a custom render pass against Cesium internals). Keep
it in the back pocket; the CPU two-pass refine is the right first ship. Upstream
`CesiumGS/cesium#13326` may eventually provide official splat picking and obsolete both.

---

## File manifest (what to read, in order)

| File | Role | Port? |
|---|---|---|
| `web-page/src/SplatPivotSource.js` | **The GS pivot fallback. The thing to port.** | **Yes — core** |
| `web-page/src/RotationCenterSnap.js` | Reference: how the fallback is called + DOM marker | Reference / marker only |
| `docs/reports/2026-06-29-gaussian-splat-snap.md` | Full design story: why overlay failed, why query shipped, render-order fix | Read for rationale |
| `docs/reports/2026-06-29-rotation-center-snap-mesh.md` | The mesh pivot story — explains the platform's existing fork and the "nearest-camera" logic | Read for context |
| `tools/gs-verify.js` | GS acceptance test (adapt for platform) | Adapt |
| `tools/pivot-probe.js` | Confirms which method resolves the pivot (run on Cesium bumps) | Adapt |
| `CLAUDE.md` (§ Rotation-centre snapping, § requestRenderMode) | Terse operational notes | Read |

## One-paragraph summary to paste into a task

> Port `SplatPivotSource.js` from `3DT-Local-viewer` (CesiumJS 1.142). Gaussian splats aren't
> depth-pickable in Cesium (`#13326`), so the orbit/tilt/zoom pivot has nothing to snap to
> over splat content. `SplatPivotSource` reads the in-memory splat centres
> (`tileset.gaussianSplatPrimitive._positions` + `_rootTransform`, private fields), decimates
> to ≤40k world points, drops opacity floaters, and returns the centre nearest the camera
> within a cursor radius — pure CPU, zero GPU, <1 MB. The platform already forks
> `ScreenSpaceCameraController` for mesh/globe snapping, so insert a `SplatPivotSource.query()`
> call at the seam where the existing pivot pick misses over a splat scene. Do NOT try an
> invisible depth-writing overlay (it punches black holes in the splats). If you draw a
> rotation marker, make it a DOM overlay, not a billboard (splats render after the translucent
> pass and hide billboards). Re-verify the private field names on any Cesium upgrade with a
> `gs-verify`-style test.
</content>
</invoke>
