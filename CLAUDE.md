# 3DT-Local-viewer — notes for AI agents

Standalone Electron desktop app that displays Cesium 3D Tiles tilesets locally.
Main process: `index.js`, `menu.js`, `server.js` (embedded Express, ports 3000/3001),
`preload.js`. Renderer: `web-page/src/*.js`, bundled by rollup into `web-page/app.js`.

## Build & run gotchas

- **The renderer bundle is NOT built on launch.** `yarn start` / `npm start`
  (`electron-forge start`) only launches Electron. You MUST build `web-page/app.js`
  first, and **rebuild after any edit under `web-page/src/` or after switching branches**:
  ```bash
  cd web-page && npx rollup -c && cd ..
  ```
  Symptom of forgetting: your source change has no effect at runtime. `web-page/app.js`
  is gitignored, so a fresh checkout always needs this step.
- **Use yarn, not npm.** The project standardises on yarn 1.x; never commit
  `package-lock.json`.
- **Sample tilesets for manual testing** live (gitignored) at `postfix-hp/tileset.json`
  and `prefix-hp/tileset.json`. Load them via the in-app tileset-select menu (left/right
  for compare mode). Note: the bundled sample references some missing `subtree` files and
  logs 404s — that is the sample data, not a bug.

## requestRenderMode invariant (READ BEFORE TOUCHING THE RENDERER)

The Cesium `Viewer` is created with **`requestRenderMode: true`** (+
`maximumRenderTimeChange: Infinity`) in `web-page/src/TilesetViewer.js`. The scene renders
**only when something requests a frame** — not every vsync. This is deliberate (idle
GPU/CPU is ~92% lower).

**Consequence:** any code path that mutates the scene or camera will NOT appear on screen
until a render is requested. If you add/modify such a path, you MUST call
`scene.requestRender()` (or `viewer.scene.requestRender()`) after the mutation, or the
change will silently not show until the user nudges the camera.

You do NOT need it for things Cesium requests internally: the default
orbit/zoom/pan controller, tileset tile streaming, camera flights/`zoomTo`, and resize.

Existing explicit `requestRender()` calls (keep this list current if you add more):
- `CesiumFLYCameraController.js` — fly `clock.onTick` movement (WASD/RF)
- `CesiumCameraController.js` — heading/pitch drag (`camera.setView`)
- `TilesetViewer.js` `_buildCompareSlider` — compare-slider drag
- `initSettingsPopup.js` — every settings handler (SSE, skip-LOD, cache, wireframe, bbox, FXAA)
- `RotationCenterSnap.js` — rotation-centre marker show/hide

Per-frame `scene.preUpdate`/`scene.postUpdate` listeners still fire every animation frame
regardless of requestRenderMode — do not put expensive work there.

## Rotation-centre snapping (`RotationCenterSnap.js`)

Orbit/tilt/zoom snap their pivot to the nearest tileset point under the cursor, and a
crosshair marker shows the rotation centre during an orbit drag (left = spin, right = tilt).
This is done **without
forking Cesium**: the stock `ScreenSpaceCameraController` derives every gesture's pivot
from `scene.pickPositionWorldCoordinates`, so we shadow that one instance method with a
9-sample neighbourhood search (cursor pixel + a ring at `SNAP_RADIUS_PX`) and return the
hit **nearest the camera**. Nearest-to-camera (not nearest-to-cursor) is what makes a
click through a hole in e.g. a lattice tower snap to the near member rather than the far
background. A genuine miss returns `undefined` (no fallback — the globe is hidden), so the
controller just rotates in place.

- Verified against real 1.142 with `tools/pivot-probe.js` (which gesture calls the pick,
  how often) and `tools/verify-snap.js` (the feature: near-miss snaps, far pixel doesn't,
  marker shows/hides, camera orbits the pivot, fly mode inert). Both write `tools/traces/`.
- The marker is a **DOM overlay** (`_markerEl` in `viewer.container`), NOT a Cesium
  billboard. A billboard renders in the TRANSLUCENT pass (9) but Gaussian splats render
  later (GAUSSIAN_SPLATS pass 11) and paint over it, so a billboard marker is invisible on
  splats. The DOM element sits above the canvas and shows on any content; while an orbit
  drag (left/right) is active we project the fixed world pivot to the screen each
  `postRender` (the camera orbits it). It has a dark halo so it reads on bright (over-exposed
  splat) backgrounds.
- **Gaussian-splat tilesets** (`SplatPivotSource.js`): splats are NOT depth-pickable in
  1.142 — `pickPositionWorldCoordinates` and `scene.pick` both return nothing (they write
  no depth, carry no pick id; upstream CesiumGS/cesium#13326). So when the mesh depth-pick
  ring misses, `_resolve` falls back to the nearest **splat centre**: we read
  `tileset.gaussianSplatPrimitive._positions`/`_scales`/`_colors` + `_rootTransform`
  (private fields — re-verify on Cesium upgrade), drop floaters by opacity, decimate to a
  capped world-space set, and return the centre NEAREST THE CAMERA among those projecting
  within `SPLAT_SNAP_RADIUS_PX` of the cursor (foreground preference → lattice case holds).
  An invisible depth-writing point overlay was rejected: opaque depth points occlude the
  translucent splats (black holes). Verified with `tools/gs-verify.js` against a real
  `KHR_gaussian_splatting` tileset (snap resolves, marker visible, camera orbits, no crash).
- **Spin/tilt pivot refine** (`SplatPivotSource.refine`, `_pivotPoint`): for a splat-derived
  pivot on **spin (left-drag) and tilt (right-drag) only** — each picks once per gesture —
  the decimated centre is refined to full density (`_positions` scanned in the tileset local
  frame, opacity-weighted k-nearest → the pivot). **Zoom is left on the decimated `query()`**
  (it picks 40-60x/gesture; refining there would reintroduce the per-frame O(N) cost). The
  active gesture is tracked by the LEFT/RIGHT down/up handlers; `_lastResolveSource` gates
  refine to splat pivots (mesh depth is already exact). `_refineCount` instruments this for
  `tools/gs-measure-verify.js` (asserts tilt refines, zoom does not). Note: Cesium's
  "rotate" = spin/grab-surface, "tilt" = orbit-around-point — the names are counter-intuitive.
- **Measurement** (`MeasureTool.js`, `resolveMeasurement`): same full-density refine, one-shot
  per click, with an opacity-weighted-mean point + k-nearest spread (the ± uncertainty).
  DOM/SVG overlay (not in-scene geometry — splats paint over the translucent pass).
- TODO (Adrian wants to try later): replace the pick-wrap by **owning the orbit/pan/zoom
  handlers** directly (disable Cesium's `rotate`/`tilt`/`zoom` event types and drive the
  camera ourselves around the resolved pivot). More code and we'd re-tune the interaction
  feel, but zero coupling to Cesium's internal pick routing — which the wrap depends on and
  must be re-checked on each Cesium upgrade (run `pivot-probe.js`).

## Profiling

`tools/profile-harness.js` launches the real app headlessly (needs a display + GPU),
auto-loads a sample tileset, and records idle render frequency, microbenchmarks, CDP-driven
interaction checks, and a DevTools trace. Run:
`DISPLAY=:0 node_modules/.bin/electron tools/profile-harness.js` → `tools/traces/`.
See `docs/reports/2026-06-01-profiler-results.md` for the methodology and findings.
