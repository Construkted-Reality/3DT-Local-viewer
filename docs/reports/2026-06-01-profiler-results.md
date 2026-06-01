# 3DT-Local-viewer — Profiler Results for the Perf Cluster (2026-06-01)

Captured against the **real** renderer bundle on a machine with a discrete AMD GPU
(direct rendering) and a **119.97 Hz** display, using `tools/profile-harness.js`. The
harness launches the actual app + embedded server, auto-loads the local sample tileset
`postfix-hp` (bypassing the file dialog), lets tiles settle, then records hard counters
and a DevTools-loadable Chromium trace.

Reproduce:

```bash
DISPLAY=:0 node_modules/.bin/electron tools/profile-harness.js
# → tools/traces/summary.json  (committed)
# → tools/traces/trace-idle-baseline.json  (14 MB, gitignored; open in chrome://tracing or Perfetto)
```

## Raw numbers (`tools/traces/summary.json`)

| Phase | renders/s | postUpdate/s |
|---|---|---|
| Idle, current settings (`requestRenderMode` OFF) | **120.3** | **120.3** |
| Idle, `requestRenderMode` ON (toggled at runtime) | **10.0** | 120.3 |
| Idle, compare mode (both tilesets) | 120.0 | 120.0 |

| Microbench | per-frame | per second @120 fps |
|---|---|---|
| Credit jQuery patch (6 ops, M5) | 0.0192 ms | ~2.3 ms/s |
| Mirror property copy (L-P1, emulated 7 props) | 0.0006 ms | ~0.07 ms/s |

Trace corroboration (4 s idle window): 453 `DrawFrame`, 452 `FireAnimationFrame`,
484 `BeginFrame` ≈ display refresh — i.e. the app draws a full frame every vsync while
completely idle.

## What the data actually says

### 1. `requestRenderMode` is the real win — confirmed, and large
With it off, the scene runs a **full render every vsync (120 fps here, would be 60 on a
60 Hz panel) even when nothing changes** — pure idle GPU/CPU/power burn. Toggling
`requestRenderMode = true` at runtime cut rendering by ~92% (120 → 10/s). This is the one
optimization in the cluster that moves real numbers.

- **Residual 10/s caveat:** the sample tilesets reference missing `subtrees/**.subtree`
  files (404s in the log), so tiles never fully settle; the residual renders are almost
  certainly failed-request churn calling `requestRender`. On a complete tileset, idle
  should fall closer to ~0–1/s.
- **The known caveat still holds:** `CesiumFLYCameraController` moves the camera inside
  `clock.onTick`. Under `requestRenderMode` that movement would freeze unless the tick
  handler calls `scene.requestRender()` while a movement flag is active. Any
  `requestRenderMode` change MUST ship with that, plus a `requestRender()` on the
  settings handlers that already exist (they call it) and on compare-slider drags.

### 2. The per-frame listeners (M5 credit patch, L-P1 mirror) are real but trivial
Important nuance the static review didn't capture: **`postUpdate` and `preUpdate` fire
every animation frame regardless of `requestRenderMode`** (measured: `postUpdate` stayed
at 120/s even when `postRender` dropped to 10/s). So:

- `requestRenderMode` does **not** silence the credit patch or the mirror listener — they
  would still run ~120/s. They need their own fix if you want them gone.
- **But their cost is negligible:** the credit patch is **0.0192 ms/frame** (~2.3 ms per
  second of wall-clock at 120 fps); the mirror copy is **~0.0006 ms/frame**. Neither is a
  meaningful CPU cost. The only residual concern for M5 is that its jQuery writes can dirty
  layout/style; the 14 MB idle trace is the place to confirm whether style-recalc actually
  fires (open it and filter "Recalculate Style" inside the per-frame tasks).

**Revised priority:** M5 and L-P1 drop from "perf" to "cleanup" — fix them for tidiness
(one-shot credit patch, event-driven mirror), not for measurable speed. They were correctly
ranked low/medium in the audit; the profiler pushes them lower.

### 3. L-P2 (mousemove layout reads) — not separately measured
This path only runs during an active left-drag and is bounded by Cesium's one-move-per-frame
coalescing. It was not exercised here (no synthesized drag). Given that even the
unconditional per-frame listeners cost <0.02 ms, the per-move `clientWidth/clientHeight`
reads are very unlikely to matter; treat as cleanup, confirm later from a drag trace if ever
in doubt.

## Recommendation

1. **Do `requestRenderMode`** as a deliberate change with the fly-camera `requestRender()`
   fix and a pass over every interaction path (settings sliders, compare slider, camera
   controllers) to ensure each requests a render. This is worth a focused branch + a manual
   verify (idle should go quiet; FLY/ORBIT, sliders, and the compare split must still update
   live). Re-run the harness after to confirm idle renders/s collapses.
2. **Fold M5 + L-P1 into a cleanup commit**, not a perf one. No urgency.
3. L-P2: leave as-is unless a drag trace later shows forced reflow.

## Post-implementation verification (branch `feature/request-render-mode`)

`requestRenderMode: true` (+ `maximumRenderTimeChange: Infinity`) was enabled at Viewer
construction, and `scene.requestRender()` was added to every custom interaction path: the
fly `clock.onTick` movement, the heading/pitch `camera.setView` drag, the compare-slider
drag, and the FXAA toggle (the other settings handlers already requested a render). The
default orbit/zoom controller, tileset streaming, camera flights and resize request renders
on their own.

Re-running the harness (now with CDP-driven input) confirms the change works and does not
freeze interaction:

| Measurement | Before | After |
|---|---|---|
| Idle renders/s | 120.3 | **10.0** |
| Fly mode, no key | — | 10 (quiet) |
| **W held (fly forward)** | — | **120** (renders while moving) |
| W released | — | 10 (quiet again) |
| Rotate-drag, 20 mouse-moves | — | **20 renders** (one per step) |

Idle rendering dropped ~92%; movement renders continuously while a key/drag is active and
goes quiet on release. The residual ~10/s idle is failed-request churn from the incomplete
sample tileset (missing `subtree` files), not steady state.

**Not auto-verified (reasoned from code, worth a manual smoke test):** default
orbit/zoom/pan, compare-slider drag, the SSE/skip-LOD/cache/wireframe/bbox settings sliders,
and the Cesium tiles-inspector panel. All either call `requestRender()` in handlers we own
or rely on Cesium's built-in render requests.
