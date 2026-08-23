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
- `DynamicMsaa.js` — the restore of the sample count when the camera stops

Per-frame `scene.preUpdate`/`scene.postUpdate` listeners still fire every animation frame
regardless of requestRenderMode — do not put expensive work there. `scene.preRender`/
`scene.postRender` are the opposite: Cesium raises them **only for frames it actually draws**,
which is what the settings-panel FPS readout counts (`initPerformanceReadout` in
`initSettingsPopup.js`). An idle scene draws nothing, so that readout shows `idle`, not `0 fps`.

That readout shows two different times. **CPU frame time** is the wall time between
`preRender` and `postRender` (main-thread work only). **GPU frame time** is a real
`EXT_disjoint_timer_query_webgl2` TIME_ELAPSED query wrapped around the same span
(`createGpuTimer`); results arrive a few frames late and are discarded when the driver
reports GPU_DISJOINT. Chromium only exposes that extension because `index.js` passes
`--enable-webgl-draft-extensions`; without it the row reads `not available`. Unit tests for
both formats and the query state machine: `web-page/src/formatPerfWindow.test.mjs`.

## Dynamic multisampling (`DynamicMsaa.js`)

`scene.msaaSamples` follows the camera: 1 sample while the camera moves, the sample count from
the settings selector when the camera stops. The settings toggle is "Multisampling Only When
The Camera Stops" (`#msaa-dynamic-checkbox`, on at start). This works because of
requestRenderMode: an idle scene draws no frame, so multisampling costs nothing at rest, and
nearly every drawn frame is a frame that the camera moves through.

The movement signal is **our own comparison**, in `DynamicMsaa._check`, on `scene.preUpdate`:
the camera is compared with a reference that the class keeps, at a **tolerant** epsilon
(`MOVE_EPSILON` = 1e-9), and the camera counts as stopped after `QUIET_MS` (250 ms) with no
change beyond that. `preUpdate` runs on every animation frame, before Cesium decides to draw,
so a still scene (which draws nothing) is still checked, and the first frame of a movement
already draws at 1 sample. The restore must call `scene.requestRender()`, because nothing else
asks for the frame that shows the smooth edges.

**CAUTION — the drift, and why it defeated two earlier implementations.** CesiumJS renormalizes
the camera vectors on every frame, which moves their last bits by about 3e-16 with no input
from the user. Both earlier designs died on it:

1. *Exact comparison per drawn frame.* Reads the drift as movement directly, re-arms the
   restore for ever, sample count never comes back.
2. *Cesium's `camera.moveStart` / `camera.moveEnd`.* Looks immune, is not.
   `View.checkForCameraUpdates` compares the camera with a clone **that it re-takes on each
   difference**, so the drift ACCUMULATES against that clone and crosses its relative epsilon
   of 1e-15 about every twelfth frame. Each crossing pushes `_cameraMovedTime` forward, so the
   500 ms of quiet that `moveEnd` needs never arrives. Measured in the app against a real
   tileset, camera untouched: `direction` differed from the clone on 5 frames of 60, with
   `_cameraStartFired=true` and `since=50ms` against `wait=500ms`. `moveEnd` was unreachable,
   the sample count stayed at 1, and `cameraChanged` drew a frame every tick — a busy GPU and
   20 fps on a scene nobody was touching. Note this also latches `moveStart` on, so it never
   fires again either: the START is as unreliable as the stop.

So: comparing per frame is **correct**, comparing exactly is not. The cure is the epsilon. The
drift accumulates to about 1e-14 over a quiet period; the smallest real camera movement changes
a direction component by about 1e-5. `MOVE_EPSILON` = 1e-9 sits in that nine-order gap. The
reference is also re-taken on every real movement, so drift can never accumulate against a
stale snapshot. `DynamicMsaa.test.mjs` replays 600 frames of the measured drift and asserts
that the sample count does not move.

**CAUTION:** a change of `scene.msaaSamples` makes CesiumJS destroy and rebuild the scene
framebuffer on the next drawn frame (`FramebufferManager.isDirty` → `destroy` → a new Texture
and a new multisample Renderbuffer at the canvas size). One gesture costs two of those
rebuilds, one at the start of the movement and one at the stop.
`tools/dynamic-msaa-verify.js` measures that cost and the GPU time that the feature saves.

The selector no longer writes `scene.msaaSamples`. `DynamicMsaa` owns it. Anything that wants
to change the sample count must go through `setTargetSamples`. The start value comes from
`TilesetViewer.js` (`scene.msaaSamples = 4`, Full).

Two harnesses cover this feature. `tools/dynamic-msaa-probe.js` needs no tileset and no GPU
(ANGLE on SwiftShader) and judges the feature on the DRAWN PIXELS: it counts the blended edge
pixels of a white box and asserts hard edges while moving, smooth at rest. Its window must be
**shown** — a hidden window gets no `requestAnimationFrame`, so nothing draws and it hangs.
`tools/dynamic-msaa-verify.js` needs a display, a GPU and the sample tileset, and measures the
real GPU cost. Both need `DISPLAY` (Electron starts GTK).

## Rotation-centre snapping (`RotationCenterSnap.js`)

Orbit/tilt/zoom snap their pivot to the nearest tileset point under the cursor, and a
crosshair marker shows the rotation centre during an orbit drag (left = spin, right = tilt).
This is done **without forking Cesium**: the stock `ScreenSpaceCameraController` derives
every gesture's pivot from `scene.pickPositionWorldCoordinates`, so we shadow that one
instance method.

- **Tiered pick** (`pickTiers.js`, `PICK_POLICY` in `RotationCenterSnap.js`): try screen
  radii from small to large, stop at the first tier that hits, **nearest-to-camera within a
  tier** (foreground preference — a lattice member a few px away beats the far background
  seen through a hole). The radii are tuned on **two axes**:
  - *Operation*: **pivot** is forgiving (tier 0 is a small ring, so a closer surface just off
    the cursor takes the rotation centre); **measurement** is precise (tier 0 is the exact
    pixel, so a direct hit on far geometry is never stolen by a nearer thing a few px away —
    forgiveness only expands outward on a true miss).
  - *Tileset type*: **gs** uses wider radii than **mesh**/point-cloud (decimated splat centres
    are sparser on screen than per-pixel depth). Mesh & point cloud share one column.
  - Defaults: `pivot {mesh:[5,16], gs:[8,28]}`, `measure {mesh:[0,2,5], gs:[4,10,20]}` — FEEL
    constants, tune by clicking. The measure-mode **hover preview** (`MeasureTool`, a hollow
    ring) shows where a click would land so a bad radius is obvious before committing.
- A genuine miss (nothing in any tier) returns `undefined` (no fallback — the globe is
  hidden), so the controller just rotates in place.

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
