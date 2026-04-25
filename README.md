# 3DT Local Viewer
### By [Construkted Reality](https://construkted.com/)

This viewer displays [3D Tiles](https://github.com/CesiumGS/3d-tiles) datasets on a local machine. It is built on Electron and the [CesiumJS](https://github.com/CesiumGS/cesium) renderer.

- No installation required (portable build)
- No internet connection required
- Supports 3D Tiles **1.0** and **1.1** (e.g. UltraMesh 2.x output) via Cesium 1.140
- Cross-platform: Windows, Linux, macOS

> **Note:** The measurement tools available in earlier versions are temporarily disabled. The previous third-party measurement plugin was incompatible with current Cesium; a replacement is tracked as a TODO in `web-page/src/TilesetViewer.js`.

## Requirements

- Node.js 18 or newer
- [Yarn 1.x](https://classic.yarnpkg.com/) (this project standardises on yarn; do not commit `package-lock.json`)
- Port `3000` free (used by the embedded tileset server)

## Project layout

```
.
├── index.js              # Electron main process
├── preload.js            # contextBridge surface (window.api)
├── server.js             # Embedded Express server for tileset assets
├── menu.js               # Native application menu
├── web-page/             # Renderer (Cesium application)
│   ├── index.html
│   ├── renderer.js
│   ├── src/              # Application source (bundled by rollup → app.js)
│   ├── Cesium-1.140/     # Bundled Cesium build
│   └── rollup.config.js
└── package.json
```

## Running in development

The renderer is a rollup-bundled application; **the bundle must be built before launching Electron**.

```bash
# 1. Install Electron-side dependencies
yarn install

# 2. Build the renderer bundle (web-page/app.js)
cd web-page
yarn install
npx rollup -c
cd ..

# 3. Launch the Electron app
yarn start
```

`web-page/app.js` is gitignored — every fresh checkout needs step 2.

### Watching the renderer during development

For live rebuilds while editing files in `web-page/src/`:

```bash
cd web-page
yarn start   # gulp default: rollup pack + livereload server on port 1237
```

Then in another terminal, run `yarn start` from the project root to launch Electron.

## Building a distributable

```bash
yarn make
```

Output goes to `out/`. Makers configured in `package.json` produce:

- `@electron-forge/maker-squirrel` — Windows installer
- `@electron-forge/maker-zip` — macOS zip
- `@electron-forge/maker-deb` — Debian/Ubuntu `.deb`
- `@electron-forge/maker-rpm` — Fedora/RHEL `.rpm`

A full make on a single platform takes roughly 5–30 minutes depending on host.

## Using the viewer

1. Launch the application.
2. Click **Select 3D Tiles JSON file**.
3. Pick a `tileset.json` file from disk. The viewer will start a local Express server in the parent directory and load the tileset.

The previous Windows-only restriction on the file picker has been removed; the viewer now opens tilesets on Linux, macOS, and Windows.

## Release process

1. Bump `version` in `package.json`.
2. Add a `### x.y.z - YYYY-MM-DD` section to `CHANGELOG.md`.
3. Commit and tag.
