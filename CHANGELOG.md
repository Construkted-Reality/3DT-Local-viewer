# Change Log

### 1.8.0 - 2026-08-23

#### Added

- `.github/workflows/release.yml`: a GitHub Actions workflow that builds the Linux and the Windows package and publishes them on a GitHub release. Push a tag that starts with "v" to run it. The workflow builds the renderer bundle first, because electron-forge does not build it and git does not carry it. The release notes come from the section of this file for that version.

#### Changed

- Multisampling is off by default. CesiumJS uses 4 samples, which costs GPU memory and GPU time on every drawn frame. The Multisampling control in the settings panel turns it on, and the control shows the real state at start.
- Settings: the anti-aliasing checkbox is now named "Anti-Aliasing (FXAA)". The old name was ambiguous, because the panel also has a multisampling control and multisampling is anti-aliasing too. The checkbox controls the post-process filter `scene.postProcessStages.fxaa`. The selector controls `scene.msaaSamples`. The two are independent.
- The packaged app no longer carries `docs`, `tools`, `.github` or the dependencies of the renderer build. The packager ignores them.

### 1.7.0 - 2026-08-23

#### Added

- Measurement tool: click two points and read the distance between them. A MEASURE button in the navigation control bar starts it. The tool and fly mode exclude each other. The read-out is a DOM and SVG overlay, because Gaussian splats draw after the translucent pass and would cover in-scene geometry.
- Measurement on Gaussian splats uses a two-pass pick. The first pass queries the decimated set of splat centres. The second pass (`SplatPivotSource.refine`) scans the full-density centres near that hit and returns the true nearest centre, an aggregate of the nearest few weighted by opacity, and the spread of that aggregate as the uncertainty. The refine runs once per click.
- Tiered snapping by operation and by tileset type (`pickTiers.js`, `PICK_POLICY`). The search tries a small radius first and stops at the first hit, so a direct hit on far geometry is never stolen by a nearer surface a few pixels away. The pivot uses forgiving radii and prefers the foreground. Measurement uses precise radii. Gaussian splats use wider radii than a mesh, because the decimated centres are sparser.
- Measure mode shows a hover ring where a click would land.
- The rotation-centre crosshair now also appears during a tilt (right drag).
- `tools/gs-measure-verify.js`: a harness that drives the real app against a Gaussian-splat tileset and checks the refine, the precision delta, a known distance, and the overlay.
- `web-page/src/pickTiers.test.mjs` and `web-page/src/SplatPivotSource.test.mjs`: headless tests for the tier search and for the refine.

#### Changed

- The spin and the tilt gestures refine the splat pivot to full density, because they pick the pivot once per gesture. Zoom keeps the decimated query, because it picks 40 to 60 times per gesture. A per-frame memo bounds the refine to one call per frame and per pixel.

#### Known limits

- The Gaussian-splat measurement and the tiered snapping are verified by headless tests only. They are not yet verified in the running app, which needs a display, a GPU and a Gaussian-splat tileset. Run `tools/gs-measure-verify.js` to close this.
- The 1.6.0 settings-panel work is also not yet verified in the running app. Run `tools/msaa-verify.js` and `tools/perf-readout-verify.js` to close this.

### 1.6.0 - 2026-08-23

#### Added

- Settings: "Multisampling (MSAA)" selector with Off (1 sample), Half (2 samples) and Full (4 samples). It writes `scene.msaaSamples`. If the WebGL context reports no multisampling support, the control is disabled and reads Off.
- Settings: "Performance" block showing the frame rate, the CPU frame time and the GPU frame time. The frame rate counts the frames that CesiumJS really draws. The CPU frame time is the main-thread work between `scene.preRender` and `scene.postRender`. The GPU frame time is a WebGL2 `EXT_disjoint_timer_query_webgl2` TIME_ELAPSED query around the same span. All three read "idle" when the scene draws nothing, which is the normal state of `requestRenderMode`.
- `tools/msaa-verify.js` and `tools/perf-readout-verify.js`: scripted checks that drive the real app.
- `web-page/src/formatPerfWindow.test.mjs`: unit tests for the readout formats and for the timer-query state machine.
- Settings: the version of the running app at the bottom of the panel. The renderer asks the main process for `app.getVersion()` over IPC, so a renderer bundle that nobody rebuilt cannot show an old version.

#### Changed

- `web-page/src/config.js` is replaced by `web-page/src/appVersion.js`. The old module read the version from `web-page/package.json`, which carries its own version for the bundle build. It therefore reported 1.0.4 in the console, not the version of the app.
- The main process passes `--enable-webgl-draft-extensions`. Chromium hides `EXT_disjoint_timer_query_webgl2` without it, and the GPU frame time needs that extension. If the extension is still missing, the row reads "not available".

### 1.5.0 - 2026-06-29

#### Added

- Rotation-centre snapping: orbit, tilt and zoom move the pivot to the nearest tileset point under the cursor, and a crosshair marker shows the rotation centre during a left drag. Gaussian-splat tilesets fall back to the nearest splat centre, because splats write no depth in CesiumJS 1.142.

#### Changed

- Upgraded bundled CesiumJS from 1.140 to 1.142.
- The viewer runs in `requestRenderMode`. It draws a frame only when the scene changes, which lowers idle GPU and CPU use by about 92 percent.

#### Fixed

- Camera: `validPitch` clamps in signed radians.
- Server: `startServer` reports a bind error instead of failing silently, and the gzip check resolves against the served directory.
- Security: the main process blocks navigation away from the bundled page and the renderer runs sandboxed.

### 1.4.0 - 2026-05-31

#### Added

- Settings: editable number input next to the rendering-performance slider for typing an exact screen-space-error value.
- Settings: "Skip Level of Detail" toggle, exposing the CesiumJS `skipLevelOfDetail` knob to trade smoother refinement for lower peak memory.
- Settings: "GPU Tile Cache (MB)" input that sets each tileset's `cacheBytes`, raising the cache budget above the default ~1 GB cap so detailed tiles stop degrading as more load. In compare mode the cache size is mirrored across both sides.

### 1.3.0 - 2026-05-31

#### Added

- Per-side stats panels showing tiles loaded, GPU memory, and a "Compute time to load" benchmark for each compare side.
- CesiumJS 3D Tiles Inspector (hidden by default), enabled via Settings. In side-by-side comparison mode its display and debug settings are mirrored to both the left and right tilesets.

#### Changed

- 3D Tiles Inspector "Enable Picking" now starts unchecked (picking off by default).

### 1.2.0 - 2026-04-25

#### Changed

- Upgraded Electron 12 → 41 (current stable). Electron 12 was EOL in May 2022.
- Upgraded electron-forge 6.0.0-beta.57 → 7.11.

#### Security

- Renderer process now runs with `contextIsolation: true`, `nodeIntegration: false`, and no `remote` module access. Renderer talks to main exclusively through a typed `contextBridge` surface (`window.api`).
- Tileset URL is JSON-escaped before being interpolated into `webContents.executeJavaScript`, removing a path-injection vector.

#### Removed

- Unused dependencies: `request` (deprecated package), `yargs`, `electron-squirrel-startup`.
- `menu-functions.js`: superseded by IPC handlers in the main process and the preload `contextBridge` surface.

### 1.1.0 - 2026-04-25

#### Changed

- Upgraded bundled CesiumJS from 1.81 to 1.140. Required for tilesets using the 3D Tiles 1.1 spec (e.g. UltraMesh 2.x output).
- `Cesium3DTileset` now loaded via the modern async `Cesium3DTileset.fromUrl()` API.

#### Fixed

- "Select 3D tiles JSON file" now works on Linux and macOS (was previously gated to Windows only).
- Cleared corrupted Cesium ion access token that contained a literal `…` character mid-JWT and produced a 401 on every launch.

#### Removed

- Measurement tools temporarily disabled: the bundled `CesiumMeasurementPlugin.js` is incompatible with Cesium 1.140 and needs replacement. See `TODO` in `web-page/src/TilesetViewer.js`.
- Default BaseLayerPicker disabled (was attempting to load Cesium ion's asset catalog, which is unnecessary for local-only tileset viewing).

#### Internal

- Renamed `CHAGELOG.md` to `CHANGELOG.md`.
- Renderer-process console output is now forwarded to the main-process log to aid debugging on frameless windows.

### 1.0.5 - 2022-10-28

#### Fixed

- Error on loading tileset.json generated UltraMesh 1.6.7. [11](https://github.com/Construkted-Reality/3DT-Local-viewer/issues/11)

### 1.0.4 - 2021-06-15

#### Fixed

- fix error in loading 3d tile. [5](https://github.com/Construkted-Reality/3DT-Local-viewer/issues/6)

### 1.0.3 - 2021-06-06

#### Fixed

- Orbit mouse button functions. [5](https://github.com/Construkted-Reality/3DT-Local-viewer/issues/5)
- Measure buttons. [4](https://github.com/Construkted-Reality/3DT-Local-viewer/issues/4)

### 1.0.2 - 2021-06-06

#### Changed

-  json file selection. [3](https://github.com/Construkted-Reality/3DT-Local-viewer/issues/3)

#### Added

-  Navigation modes and tools menu. [2](https://github.com/Construkted-Reality/3DT-Local-viewer/issues/2)

### 1.0.1 - 2021-06-04

#### Changed

-  Visual changes. [1](https://github.com/Construkted-Reality/3DT-Local-viewer/issues/1)

 
#### Added
#### Fixed
#### Changed
#### Improved
