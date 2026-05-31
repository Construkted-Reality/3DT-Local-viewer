# Change Log

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
