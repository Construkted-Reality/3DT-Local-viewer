# Snapping the rotation centre to geometry — without forking Cesium

*2026-06-29 · feature/rotation-center-snap · commit 164b79e*

## The problem

In an orbit camera, left-drag rotates the view around a pivot. CesiumJS picks that
pivot from whatever is under the cursor when you press the mouse. The trouble starts
when you press *slightly off* the model: the pick misses the geometry, Cesium falls back
to the WGS84 ellipsoid surface, and — with the globe hidden, as it is in this viewer —
that fallback point can sit far below or behind the model. The camera then swings around
a point "off in the distance," which feels broken.

The fix everyone reaches for: snap the pivot to the nearest point that *is* on the
geometry, and show a marker so the user can see where they're rotating around.

## The reference, and the trap

Our own web platform (`construkted.js`) already does this. We looked at how. The answer
was sobering: it **forks Cesium's entire `ScreenSpaceCameraController.js`** — ~3100 lines
— into the repo and adds two fields (`enableSnap`, `snapOffset`), overriding the
controller's private `pickGlobe` with a 9-point grid sample (the cursor pixel plus a ring
at `snapOffset` px) that returns the hit nearest the camera.

It works, but the cost is brutal: a 3000-line vendored copy of a fast-moving upstream file
that has to be re-merged on every Cesium upgrade. We had *just* finished the 1.140→1.142
bump (commit 26efebf). Forking the camera controller was exactly the kind of debt we
didn't want to take on. So the first real decision was: **find a lighter hook, or prove
one doesn't exist.**

## Reading the terrain

Two facts shaped the approach:

1. **The globe is hidden.** This is a pure 3D-Tiles viewer (`scene.globe.show = false`).
   So the pivot pick that matters isn't the globe/terrain path the web platform overrode —
   it's the **depth-buffer pick against the tileset**, `scene.pickPositionWorldCoordinates`.
2. **Cesium is a prebuilt, minified global.** It's loaded as `<script>` and treated as an
   external (`window.Cesium`). There's no Cesium source in-tree to patch. Forking the
   controller would mean vendoring and maintaining a patched build.

That pointed at a hook the web platform never needed: if Cesium's controller derives every
gesture's pivot from `scene.pickPositionWorldCoordinates`, we could **shadow that one
instance method** with a snapping wrapper and never touch Cesium's source. ~40 lines
instead of 3000.

The catch: "if." `pickPositionWorldCoordinates` is a public method, but whether the
controller actually routes the rotate/tilt/zoom pivot through it — versus picking the
ellipsoid directly — is an internal detail of a *minified* build. Guessing wrong would
mean building the whole feature on sand.

## The spike that earned the design

Rather than reason about minified code, we drove the real app. `tools/pivot-probe.js`
launches the actual renderer headlessly (it reuses the profiling harness's CDP plumbing),
loads a tileset, wraps `pickPositionWorldCoordinates` with a counter, then dispatches real
rotate / tilt / zoom gestures and reports how often each calls the method and whether the
camera moved.

The probe paid for itself several times over:

- **Routing confirmed.** Rotate calls the pick once per gesture, tilt once, zoom 40–60×.
  Wrapping that one method intercepts the pivot for all three.
- **A hit *orbits* the picked point.** With the cursor on the model, left-drag gave
  `posDelta 63, angleDelta 0` — the camera swung *around* the pivot. With a miss,
  `posDelta 0, angleDelta 0.1` — it rotated in place. So snapping the *pick* snaps the
  *orbit centre*: the whole feature flows through one hook.
- **A miss returns `undefined`.** With the globe hidden there's no far-ellipsoid fallback
  in this method, so a genuine miss just lets the controller rotate in place — benign.

It also surfaced two bugs in our own test rig before they could mislead us: the bundled
sample tileset uses implicit tiling whose subtree files 404, so *nothing* loads or picks
(we built a minimal explicit tileset from the existing GLBs to get pickable geometry); and
CDP mouse events use viewport coordinates while the depth scan used canvas coordinates —
a 30px menu-bar offset that made every synthetic click miss until we converted through the
canvas bounding rect.

## The design argument

With the hook proven, the question became *what to snap to*. The first instinct was to
copy the web platform's 9-point grid. Adrian pushed back — rightly — that "we did it
before" isn't a reason. That kicked off the most useful exchange of the project:

- A fixed 9-point grid at 5px only helps if you're within 5px of the silhouette. Click
  further off and it fails right back to the bad fallback.
- A first proposal — fall back to the tileset bounding sphere on a miss — was correctly
  shot down: rotating around a bounding-sphere point is rotating around a place the user
  never pointed at.
- The decisive insight came from a concrete case Adrian raised: a lattice tower with open
  gaps. Click *through* a gap and the direct pick hits the ground 200 m back. You don't
  want to orbit that. The fix is to **always sample a neighbourhood and prefer the hit
  nearest the camera** — so the near lattice member a few px away beats the far background
  seen through the hole.

And that closed the loop: "nearest to camera" is *exactly* the metric the web platform's
grid already used. Its mechanism was sound all along — what was wrong was *where* it
hooked (a 3000-line fork) and that it only covered the globe path. So the final design is
the web platform's selection logic, our clean instance-wrap, applied to the tileset depth
pick: **sample the cursor pixel plus a ring of 8 at `SNAP_RADIUS_PX`, return the hit
nearest the camera, memoised per frame** (so a zoom burst's dozens of calls collapse to
one search).

## What shipped

- `RotationCenterSnap.js`: shadows `scene.pickPositionWorldCoordinates` with the 9-sample
  nearest-to-camera search; shows a crosshair marker on left-drag; inert in fly mode.
- No Cesium fork. No settings UI (a deliberate call — a parameter-free design beats a
  fixed-and-untunable 5px). The search radius is a code constant.
- Verified end-to-end by `tools/verify-snap.js` against the real 1.142 app: a near-miss
  pixel (exact pick misses, geometry within R) snaps; a pixel far from any geometry does
  *not* (no yanking the pivot across the screen); the marker shows on press and hides on
  release; the camera orbits the snapped point; fly mode stays inert.

## The lesson

The reference implementation was simultaneously right and wrong: right about the
algorithm, wrong about the integration. The win wasn't a cleverer pivot — it was refusing
to inherit a 3000-line maintenance liability and spending a 100-line spike to prove a
40-line hook would do instead. Measure the real system; don't port the scaffolding.

> Caveat carried forward: the wrap depends on Cesium routing the pivot through
> `pickPositionWorldCoordinates`. True for 1.142; **re-run `pivot-probe.js` on every
> Cesium upgrade.**
