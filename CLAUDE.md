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
crosshair marker shows the rotation centre during left-drag. This is done **without
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
- The marker is an SVG-data-URI billboard entity with depth test disabled; it follows the
  rotation centre only on plain left-drag (rotate), and is inert while fly mode owns the
  camera.
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
