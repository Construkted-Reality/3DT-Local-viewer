# 3DT-Local-viewer — Bug Hunt & Optimization Report (2026-05-31)

## Executive summary

All findings below have been adversarially verified against the real source. Several near-identical findings were merged (the `validPitch` unit/wraparound pair; the four overlapping `checkGzipAndNext` findings; the duplicate `newButton` findings; the SIGINT-leak and the server-CLI-cruft quality finding).

Severity counts (post-dedup, using the adversarially-adjusted severities):

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 4 |
| Medium | 5 |
| Low | 14 |

By category:

| Category | Count |
|----------|-------|
| Security | 5 |
| Robustness | 5 |
| Performance | 4 |
| Bug / correctness | 3 |
| Resource leak | 1 |
| Quality / simplification | 5 |

### The first 3–5 things to do, and why

1. **Fix the server bind-failure crash + make `startServer` await its `listening` event (server.js + index.js).** This is the single highest-leverage change: today an already-taken port (a second app instance, or any process on 3000/3001) silently kills the whole Electron app via `process.exit(1)` with no dialog. It is trivially reproducible (launch two instances) and the two findings are really one fix — turn `startServer` into a promise, reject on `error`, surface a dialog, and never `process.exit` from a module embedded in the main process. Unblocks correct error UX everywhere downstream.
2. **Add `setWindowOpenHandler(deny)` + `will-navigate` guard (index.js).** One file, a few lines, zero functional regression for an app that only ever loads one local file. Closes the standard Electron navigation-hijack gap on a non-sandboxed, preload-privileged window. Easy to verify (links/window.open simply do nothing or route to `shell.openExternal`).
3. **Vendor FontAwesome locally and add a CSP (web-page/index.html, optionally index.js).** Removes a remote executable-JS supply-chain dependency loaded on every launch and restores defense-in-depth. Needs an iteration on the exact CSP string (inline `<script>` blocks and Cesium workers/eval must be accounted for), so budget for tuning.
4. **Fix `validPitch` to clamp in signed radians (web-page/src/validPitch.js).** The clamp is currently a no-op because radian input is compared against degree thresholds; in fly mode the camera can pitch past vertical and gimbal-flip. Single tiny file, the fix can only restore intended behavior (the prior code clamped nothing).
5. **Fix the gzip-detection path in `checkGzipAndNext` (server.js).** It reads relative to the process cwd instead of the served `dir`, so gzip detection never works and pre-gzipped tilesets fail to render. Resolving against `dir` also fixes the related path-traversal oracle and the silent error-swallow in one edit. Needs a runtime check with an actual gzipped tileset.

---

## Critical & High findings

### H1. Server bind failure kills the entire app via `process.exit(1)` with no user-facing error

- **File:** `server.js:101-118` (and the caller `index.js:96-103`)
- **Evidence:**
  ```js
  server.on("error", function (e) {
      if (e.code === "EADDRINUSE") { console.log("Error: Port %d is already in use...", port); }
      else if (e.code === "EACCES") { ... }
      console.log(e);
      process.exit(1);
  });
  ```
- **Impact:** `server.js` runs **in-process** in the Electron main process (`index.js:3` `require('./server')`), not as a forked child. `startServer` is invoked synchronously from `loadTilesetForSlot` on user IPC (`select-3d-tile-folder`). Ports are hardcoded (`slot === 'right' ? 3001 : 3000`). If either port is held — a second instance, or any other process — the async `listen` `'error'` fires and `process.exit(1)` terminates the whole app. The user sees the window vanish; the message goes only to a console no packaged-app user ever sees.
- **This is one fix together with H2.** `startServer` returns *before* `listen` completes, so the caller cannot catch the failure. `index.js:96-103` has already told the renderer to fetch `http://localhost:${port}/${baseName}` before the socket is guaranteed up — a real start-vs-fetch race in addition to the crash.
- **Suggested fix:** Make `startServer` return a Promise that resolves on `'listening'` and rejects on `'error'`. `await` it in `loadTilesetForSlot` before `executeJavaScript`. On rejection, show `dialog.showMessageBoxSync` and keep the app alive (optionally retry on the next port). Never call `process.exit(1)` from this module.
- **Profiler:** Not a performance item; verify by launching a second instance (or `nc -l 3000`) and selecting a tileset — the app must show a dialog and stay alive instead of vanishing.

### H2. `startServer` error is asynchronous and unhandled in `index.js`

- **File:** `index.js:96-103`
- **Evidence:**
  ```js
  stopServer(slot);
  startServer(slot, port, dir);
  const tilesetUrl = `http://localhost:${port}/${baseName}`;
  mainWindow.webContents.executeJavaScript(`window.tilesetViewer.${method}(...)`);
  ```
- **Impact:** No success/failure signalling between server start and renderer fetch. On bind failure the process dies (H1) before the existing `tileset-load-error` IPC handler can ever run; on a slow bind the renderer fetches a port that is not yet listening.
- **Suggested fix:** Covered by H1 (await the `listening` event before instructing the renderer; reject + dialog on error). Closes both the crash and the race.

### H3. No `will-navigate` / `setWindowOpenHandler` guards on the BrowserWindow

- **File:** `index.js:12-35`
- **Evidence:** `mainWindow = new BrowserWindow({ ... sandbox: false, preload: ... });` then `loadFile('./web-page/index.html')`. A repo-wide grep finds no `will-navigate`, `will-redirect`, or `setWindowOpenHandler` anywhere.
- **Impact:** The renderer loads untrusted tileset JSON/3D-tiles over `http://localhost` and a remote FontAwesome script, with `sandbox:false` and a Node-bridged preload. Nothing intercepts top-level navigation or window creation. A crafted tileset URL, injected anchor, or `window.open` could navigate this privileged window to attacker content or spawn unmediated child windows — the standard Electron hardening gap. (Conditional on content triggering navigation rather than a direct RCE, but high is defensible given where it lands.)
- **Suggested fix:**
  ```js
  mainWindow.webContents.on('will-navigate', (e, url) => {
      if (url !== mainWindow.webContents.getURL()) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ```
  Open legitimate external links only via `shell.openExternal` after validating the protocol is `https`.
- **Profiler:** N/A. Verify the app still loads and that `window.open`/cross-origin nav does nothing.

### H4. No Content-Security-Policy, and a remote third-party script is loaded on every launch

- **File:** `web-page/index.html:14`
- **Evidence:** `<script src="https://kit.fontawesome.com/1c9144b004.js" crossorigin="anonymous"></script>`. No CSP meta tag; no `onHeadersReceived` CSP injection in the main process.
- **Impact:** Executable JS is pulled from a CDN on every launch. With no CSP, a compromised/hijacked CDN script or any XSS runs in the renderer DOM. (Blast radius is meaningfully reduced by `nodeIntegration:false` + `contextIsolation:true`, which confine a compromised script to the limited `window.api` surface rather than raw Node — but the supply-chain exposure and missing defense-in-depth remain real, hence high.)
- **Suggested fix:** Vendor FontAwesome locally (remove the kit script) and add a strict CSP, either via meta tag or `session.defaultSession.webRequest.onHeadersReceived`. **The literal policy needs tuning:** a bare `script-src 'self'` would break the inline `<script>` blocks at index.html lines 17/21 and Cesium's worker/eval usage. Plan for `worker-src`/`blob:` and either hashes or a scoped `'unsafe-inline'`.
- **Profiler:** N/A. Multiple iterations likely while tuning the CSP so Cesium and the inline shims still run; verify no console CSP violations and that tilesets render.

---

## Medium findings

### M1. `validPitch` never clamps — radian input compared against degree thresholds, and the wraparound model is wrong

- **File:** `web-page/src/validPitch.js:1-14` (merges the unit-mismatch and 0..360-wraparound findings — same root bug)
- **Evidence:**
  ```js
  const MAX_PITCH_IN_DEGREE = 88;
  if (pitch > MAX_PITCH_IN_DEGREE * 2 && pitch < 360 - MAX_PITCH_IN_DEGREE) { pitch = 360 - MAX_PITCH_IN_DEGREE; }
  else if (pitch > MAX_PITCH_IN_DEGREE && pitch < 360 - MAX_PITCH_IN_DEGREE) { pitch = MAX_PITCH_IN_DEGREE; }
  ```
- **Impact:** The only caller (`CesiumCameraController.js:85`) passes a signed radian value (`camera.pitch` ∈ ~[-1.57, 1.57]). All comparisons are against 88/176/272, which a radian value can never reach, so the function is a no-op. The intended ±88° clamp never happens, and negative pitch is never clamped symmetrically. In fly mode (handler wired via `CesiumFLYCameraController.start()` → toolbar button) the camera can pitch past vertical and gimbal-flip. UX defect, not a crash — hence medium.
- **Suggested fix:** Operate in radians with a symmetric signed clamp; drop the 360-based branch entirely:
  ```js
  const MAX = CesiumMath.toRadians(88);
  return CesiumMath.clamp(pitch, -MAX, MAX);
  ```
  Import `CesiumMath` into `validPitch.js`. Regression-free because the prior code clamped nothing.
- **Profiler:** N/A. Verify by dragging pitch to extremes in fly mode and confirming it stops at ±88°.

### M2. Gzip detection reads from process cwd instead of the served dir; also a traversal oracle and a silent error-swallow

- **File:** `server.js:57-72` (merges the three overlapping `checkGzipAndNext` findings: wrong base path, path-traversal, swallowed errors)
- **Evidence:**
  ```js
  const filePath = reqUrl.pathname.substring(1);
  const readStream = fs.createReadStream(filePath, { start: 0, end: 2 });
  readStream.on("error", function (err) { next(); });
  ```
- **Impact:**
  - **Functional (the real harm):** `express.static` is mounted on `dir`, but the gzip sniff builds `filePath` relative to the process cwd, not `dir`. For any tileset folder that isn't the cwd (the normal case), the read fails with ENOENT, `next()` fires without `Content-Encoding: gzip`, and gzip-compressed tiles (`.b3dm`/`.pnts`/etc.) are served as raw gzip bytes Cesium cannot parse. **Pre-gzipped tilesets fail to render.**
  - **Security (lower blast radius):** the path is taken from the URL with no containment guard, so a raw-socket `GET /../../../etc/passwd` reaches `fs.createReadStream` on an attacker-chosen path. Verified exploitable as a 3-byte gzip-magic/existence **oracle** (leaked via the response header), not content exfiltration — file bodies still come from `express.static(dir)`, which normalizes `..`. The server is localhost-bound but sets `Access-Control-Allow-Origin: *`.
  - The `'error'` handler swallows every read failure with no logging.
- **Suggested fix:** Resolve against the served dir and confirm containment, decode the path, and log errors:
  ```js
  const resolved = path.resolve(dir, '.' + decodeURIComponent(reqUrl.pathname));
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) return next();
  const readStream = fs.createReadStream(resolved, { start: 0, end: 2 });
  ```
  (`require('path')`.) Fixes gzip detection, closes the oracle, and stops the silent swallow in one edit.
- **Profiler / runtime confirmation (`needs_runtime_confirmation=true`):** Serve an actually gzip-compressed tileset and confirm responses now carry `Content-Encoding: gzip` and the tileset renders. Confirm a raw `GET /../../x` request returns `next()`/404 with no header set.

### M3. Renderer sandbox disabled (`sandbox: false`)

- **File:** `index.js:19`
- **Evidence:** `nodeIntegration: false, contextIsolation: true, sandbox: false, preload: ...`
- **Impact:** Defense-in-depth gap — the renderer/preload run without the OS process sandbox, enlarging the blast radius of a renderer compromise (combined with the remote CDN script, no CSP, no nav guards). The primary controls (`nodeIntegration:false`, `contextIsolation:true`) are correctly set, so this is the OS-level backstop, not a direct hole — hence medium.
- **Suggested fix:** Set `sandbox: true`. `preload.js` uses only `contextBridge`/`ipcRenderer`, which remain available under the sandbox, so no preload changes are needed.
- **Profiler / runtime confirmation (`needs_runtime_confirmation=true`):** Launch the app and exercise every IPC path (window min/max/close, both tileset-select dialogs, error notification) to confirm nothing broke under the sandbox.

### M4. SIGINT handler re-registered on every server (re)start — listener accumulation

- **File:** `server.js:124-137` (subsumes the related "leftover CLI dev-server messaging" quality finding L13)
- **Evidence:**
  ```js
  let isFirstSig = true;
  process.on("SIGINT", function () { if (isFirstSig) { server.close(...); isFirstSig = false; } else { process.exit(1); } });
  ```
- **Impact:** `startServer()` runs on every folder selection (`stopServer`/`startServer` in `loadTilesetForSlot`, for both slots). Each call adds a fresh `process.on('SIGINT', ...)` closing over a now-stale, already-closed server, and neither `stopServer` nor the close-at-top removes it. After ~10 selections Node emits `MaxListenersExceededWarning`; stale closures retain references to closed server objects. (The "SIGINT semantics break" claim is slightly overstated — the live-server handler still works — but the leak is real.) The same block also `process.exit`es, fighting Electron's lifecycle, and the module still prints CLI-only hints like `node server.cjs --port N`.
- **Suggested fix:** Register a single SIGINT handler once at module load that iterates the `servers` map and closes all; do not register inside `startServer`. Drop the `node server.cjs` CLI hints and rely on `stopServer` + the Electron app lifecycle for shutdown.
- **Profiler:** N/A. Verify by selecting folders 12+ times and confirming no `MaxListenersExceededWarning`.

### M5. `scene.postUpdate` runs multiple jQuery DOM queries/mutations every frame

- **File:** `web-page/src/TilesetViewer.js:67-77`
- **Evidence:** Per-frame `jQuery("a[href=...]").attr(...)`, `jQuery("img[title='Cesium ion']").attr('src', ...)`, `.cesium-credit-textContainer.hide()`, `.cesium-credit-expand-link.show()/.html(...)` — six idempotent jQuery operations.
- **Impact:** `requestRenderMode` is off (see M6 family), so `postUpdate` fires every rendered frame (~60fps) for the viewer's lifetime (no `removeEventListener`). Each frame runs attribute-selector DOM walks plus style/innerHTML writes that can dirty layout. Pure waste — the credit DOM only needs patching once after creation. Modest relative to tile rendering, hence medium.
- **Suggested fix:** Patch once — e.g. a self-removing `postUpdate` listener that `removeEventListener`s itself after the credit elements exist, or react to the credit-display change event. Cache the jQuery selections.
- **Profiler / runtime confirmation (`needs_runtime_confirmation=true`):** See the instrumentation plan; capture a Chromium performance trace and look for repeated style-recalc/jQuery frames in the idle render loop, then confirm they disappear after the change.

---

## Low findings & quality/simplification

> **Note on `requestRenderMode` (P-LOW, performance, `TilesetViewer.js:25-35`).** The Viewer is created without `requestRenderMode:true`, so Cesium re-renders every animation frame even when idle. This is the root enabler of M5 and the two per-frame handlers below; enabling explicit-render mode would drop idle GPU/CPU to near zero. It is listed here as a low/medium-boundary performance item because the fix has a real coupling caveat: the fly controller moves the camera inside `clock.onTick` and would freeze under explicit-render mode unless it calls `scene.requestRender()` while a move flag is active. Treat it as the umbrella optimization once M5 and the polling handlers are understood. Needs runtime confirmation.

### Performance (low)

- **L-P1. `preUpdate` mirror handler runs every frame** — `TilesetViewer.js:125-130`. Mirrors ~25 tileset + 7 point-cloud-shading props every frame in compare mode. `mirrorTilesetSettings` already early-returns when the target is undefined, so single-tileset mode only pays a one-property read; the full loop runs only with both slots loaded. **Fix:** drive from inspector viewModel (knockout) change events, or early-return when not in compare mode. *Needs runtime confirmation.*
- **L-P2. Heading/pitch mousemove reads `clientWidth/clientHeight` + `setView` per move** — `CesiumCameraController.js:72-89`. Only runs during an active left-drag; Cesium coalesces MOUSE_MOVE to one/frame so it's bounded, but the per-event layout reads are easily hoisted. **Fix:** cache canvas size, update on a resize listener. *Needs runtime confirmation.*
- **L-P3. Fly-controller `clock.onTick` listener lives for the app's lifetime** — `CesiumFLYCameraController.js:72-98`. Early-returns when `!this._started`, so cost is negligible today. **Acceptable as-is.** If `requestRenderMode` is ever enabled, add `scene.requestRender()` inside the move-flag branch so WASD movement keeps rendering. *Needs runtime confirmation.*

### Bug / robustness (low, latent)

- **L-B1. `newButton` dereferences `undefined` icon when `iconClass` is empty** — `web-page/src/NavigationControlbar.js:55-67`. The `if (iconClass != '')` guard leaves `icon` undefined, then `icon.outerHTML` throws. Both current callers pass non-empty classes, so latent. **Fix:** `button.innerHTML = (icon ? icon.outerHTML : '') + text;`
- **L-B2. `loadTilesetForSlot` indexes `tilesetPath[0]` without a length guard** — `index.js:84-92`. The `!tilesetPath` guard handles cancel (undefined), but a (undocumented) empty array would make `path.dirname(undefined)` throw. Defensive only. **Fix:** `if (!tilesetPath || tilesetPath.length === 0) return;` (The finding's title mention of "title uses raw array" is a mislabel; the real issue is the unguarded index.)
- **L-B3. Tileset URL injected into renderer via `executeJavaScript` string interpolation** — `index.js:99-103`. Not exploitable as written (`JSON.stringify` escapes both user-derived values; `method` is a fixed literal), but a fragile code-as-string pattern. **Fix:** push values over a dedicated IPC channel that the preload forwards to `window.tilesetViewer.addTileset`; or keep `JSON.stringify` on every value with a documenting comment.
- **L-B4. `checkGzipAndNext` hangs the request for a zero-byte file** — `server.js:57-72`. A 0-byte file matching a tileset-format regex emits `'end'` with no `'data'`/`'error'`, so `next()` is never called and the request hangs until client timeout. (No fd leak — `close` fires and Node releases the fd; only the socket hangs.) **Fix:** add `readStream.on('end', () => next())` with a call-once guard so `data`+`end` don't double-`next()`. *Needs runtime confirmation.*
- **L-B5. Renderer DOM bindings assume all elements exist** — `web-page/renderer.js:2-44`. Unchecked `getElementById`/`querySelector` + `window.tilesetViewer` access in one `DOMContentLoaded` handler; a null lookup would TypeError and abort the rest. All referenced IDs currently exist and `app.js` (which sets `window.tilesetViewer`) loads before `renderer.js`, so impact is hypothetical — a defensive nit. **Fix:** null-check before `addEventListener`; guard `if (window.tilesetViewer)`.
- **L-B6. Benchmark reload swallows load errors silently** — `web-page/src/TilesetViewer.js:329-333`. On `computeLoadTimes`, the slot's tileset is removed then reloaded; on reload failure the `catch { return; }` leaves the view empty, stats at `---`, and no feedback (`_tilesetLoadError` has no subscribers anywhere). Rare edge (source becomes unavailable between load and benchmark). **Fix:** write a visible message to `els.benchmarkNotice` in the catch.

### Quality / simplification (low)

- **L-Q1. Dead web-run-mode block** — `web-page/src/index.js:14-16`. `config.runMode` is never defined (`config.js:5` has it commented out), so the branch and its stray remote URL are unreachable. **Fix:** remove the block and the `//runMode` comment.
- **L-Q2. Dead mobile code paths** — `CesiumCameraController.js:46-59`. `isMobile` is always `false` (sole construction site `TilesetViewer.js:79-82`), and `_allowStartPositionTap`/`_startFPVPositionMobile`/`_lastTapedPosition` are never assigned. **Fix:** drop the `_isMobile`-gated lines, the mobile block, and the `isMobile` option.
- **L-Q3. Empty `_onMouseLButtonDoubleClicked`** — `CesiumCameraController.js:37,42-44`. Empty handler registered for `LEFT_DOUBLE_CLICK`; dead code (it does not actually suppress Cesium's default since it's on a separate handler instance). **Fix:** remove the method and its `setInputAction`.
- **L-Q4. Unused `testOnLocal` constant** — `CesiumFLYCameraController.js:25`. Declared, never referenced. **Fix:** delete.
- **L-Q5. `CesiumJsInc.js` re-exports 65 names, ~14 used** — `CesiumJsInc.js:1-133`. ~51 dead side-effect-free aliases. **Fix:** trim to the names actually imported by first-party src; re-add on demand.
- **L-Q6. Primitive-iteration loop duplicated 5×** — `initSettingsPopup.js` (lines 11-18, 49-56, 73-80, 98-105, 111-118). **Fix:** extract one `forEachTileset(fn)` helper (loop primitives, apply `fn` to each `Cesium3DTileset`, then `requestRender`) and call it from all five handlers.
- **L-Q7. Magic number `32` for SSE slider inversion duplicated** — `initSettingsPopup.js:9,84`. The slider↔SSE inversion constant must stay in sync. **Fix:** `const SSE_SLIDER_MAX = 32;` once; reference in both. (Name only `32`, not the `Math.max(1, …)` floor.)
- **L-Q8. `jQuery.prop('checked', fn)` obscures a one-time FXAA init read** — `initSettingsPopup.js:127-131`. Works by accident; the closure hides that it's a one-shot read. **Fix:** `jQFxaaEnableCheckBox.prop('checked', window.tilesetViewer.viewer.scene.postProcessStages.fxaa.enabled);`
- **L-Q9. Dead empty `else` in orbit handler** — `NavigationControlbar.js:34-38`. **Fix:** collapse to `if (this._flyController.started()) this._flyController.stop();`
- **L-Q10. `_onMouseUp` has an unused, misnamed parameter** — `CesiumCameraController.js:61-63`. **Fix:** `_onMouseUp () { this._leftButtonPressed = false; }` (LEFT_UP passes a single-position object, not a movement — but the param is unused regardless.)

---

## Profiler / instrumentation plan

Every item below was flagged `needs_runtime_confirmation=true`. This is an Electron + Cesium app, so use Chromium's renderer DevTools/profiler in the renderer process (the Cesium scene runs there); the server items are confirmed with curl/raw sockets against the embedded Express server.

**General setup:**
- Launch the app, then open the renderer DevTools (e.g. add a temporary `mainWindow.webContents.openDevTools()` in `index.js`, or wire a menu accelerator). Use the **Performance** tab to capture a multi-second trace while the app is idle (camera static, no tile loading) and again while dragging/flying.
- Cesium's continuous render loop means an *idle* trace is meaningful: with `requestRenderMode` off there will be ~60 frames/sec of work even when nothing changes.

1. **M5 — per-frame jQuery credit patching (`TilesetViewer.js:67-77`).** Idle Performance trace; look for recurring "Recalculate Style" / "Layout" entries and jQuery selector frames inside the per-frame render task. **Metric:** count of style-recalcs per second in the idle trace before vs. after the one-shot fix (should drop to ~0 from the credit handler).
2. **`requestRenderMode` umbrella (`TilesetViewer.js:25-35`).** Compare idle GPU/CPU with the Performance tab (or `chrome://gpu`/Task Manager renderer CPU%) before and after enabling explicit-render mode. **Metric:** idle frames-rendered-per-second should fall to ~0 (only on camera/setting changes). **Also verify** WASD/RF fly movement still renders (the `clock.onTick` `requestRender` caveat).
3. **L-P1 — per-frame `preUpdate` mirror (`TilesetViewer.js:125-130`).** Load both compare slots; idle trace and look for `mirrorTilesetSettings` self-time per frame. **Metric:** per-frame self-time of that closure in compare mode, before vs. after switching to event-driven mirroring.
4. **L-P2 — mousemove layout reads (`CesiumCameraController.js:72-89`).** Record a trace while left-dragging to rotate in fly mode; look for forced-reflow warnings ("Forced reflow" / purple layout bars) triggered by `clientWidth`/`clientHeight`. **Metric:** presence/count of forced-reflow events during a drag, before vs. after caching the canvas size.
5. **L-P3 — fly `clock.onTick` (`CesiumFLYCameraController.js:72-98`).** Only relevant if `requestRenderMode` is enabled: confirm WASD movement keeps the scene updating once `scene.requestRender()` is added to the move-flag branch. **Metric:** visual — camera moves smoothly while a key is held under explicit-render mode.
6. **M3 — `sandbox: true` (`index.js:19`).** No profiler; functional smoke test of every IPC path after flipping the flag (window controls, both folder dialogs, error notification).
7. **M2 — gzip detection / traversal (`server.js:57-72`).** With the app running, `curl -sI http://localhost:3000/<path-to-a-gzipped-tile>` and confirm `Content-Encoding: gzip` appears after the fix (and that the tileset renders). For containment, send a raw-socket `GET /../../../etc/hosts HTTP/1.1` (HTTP clients normalize `..`, so use `printf`+`nc`) and confirm the handler returns `next()`/404 with no `Content-Encoding` header.
8. **L-B4 — zero-byte hang (`server.js:57-72`).** Place a 0-byte file named e.g. `empty.b3dm` in the served dir, `curl --max-time 5 http://localhost:3000/empty.b3dm`; before the fix it times out, after it returns promptly.

---

## Recommended order of work

Ranked by dependency order, then verification difficulty, then bug-risk, then blast radius — **not** by coding effort.

1. **H1+H2 — Server bind crash + async start race (server.js + index.js).** *Unblocks correct error UX app-wide; trivially reproducible; high blast radius (whole-app death). One coordinated promise-ification fix.*
2. **H3 — Navigation/window-open guards (index.js).** *One file, near-zero regression risk, easy to verify; closes the biggest cheap security gap.*
3. **M3 — Enable `sandbox: true` (index.js).** *One-line hardening that pairs with H3; only needs an IPC smoke test. Do before the CSP work so the renderer is locked down incrementally.*
4. **M1 — `validPitch` signed-radian clamp (validPitch.js).** *Tiny isolated file; the fix can only restore behavior (current code clamps nothing); easy to verify by dragging pitch.*
5. **M2 — `checkGzipAndNext` base-path + containment + logging (server.js).** *Fixes a real rendering bug for gzipped tilesets and closes the traversal oracle and silent swallow in one edit; verifiable with curl + a gzipped tileset.*
6. **H4 — Vendor FontAwesome + CSP (index.html, index.js).** *Highest security value but ranked after the cheap wins because the CSP string needs iteration against inline scripts and Cesium workers; budget for multiple passes.*
7. **M4 — Single module-level SIGINT handler + drop CLI cruft (server.js).** *Fixes the listener leak; verify by repeated folder selection. Independent of the above.*
8. **M5 + `requestRenderMode` umbrella + L-P1/L-P2/L-P3 (TilesetViewer.js, controllers).** *Tackle as a performance cluster after a profiler trace confirms the idle render-loop cost; `requestRenderMode` is the unlock but carries the fly-movement `requestRender` caveat, so confirm with traces and a movement smoke test.*
9. **L-B1…L-B6 — latent robustness fixes.** *Defensive; do opportunistically. L-B4 (zero-byte hang) and L-B3 (executeJavaScript pattern) first within this group given clearer real-world reachability.*
10. **L-Q1…L-Q10 — dead code & simplification.** *No runtime risk; batch them in a single cleanup pass. Safe to verify by build + smoke test. Update README/docs if any touched behavior is documented.*
