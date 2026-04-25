# Research: Occlusion culling for 3D Tiles in CesiumJS

**Date:** 2026-04-25
**Status:** Research complete; implementation deferred.
**Tracking:** No issue/branch yet.

## The problem

In a dense tileset — most acute for indoor models like a multi-room building — Cesium loads geometry for tiles the camera cannot see. With many walls in a house model, every wall's geometry is fetched and uploaded to GPU even when the camera is in a single room and only one wall is visible. Network, memory, and GPU upload cost scale with total tile count rather than visible tile count.

CesiumJS already does **frustum culling** (tiles outside the view frustum are skipped) and **screen-space-error LOD** (distant tiles use lower detail). It does **not** do **occlusion culling** (tiles inside the frustum but hidden behind opaque geometry).

## Current state in CesiumJS (2026-04)

**Not implemented.** Occlusion culling appears on Cesium's [3D Tiles roadmap, issue #3241](https://github.com/CesiumGS/cesium/issues/3241), under "Later + Ongoing Performance" with the note *"Occlusion culling. Drive refinement with VMSSE?"* — i.e. acknowledged as a target but not scheduled.

The same feature exists and ships in **Cesium for Unreal**, where it leverages Unreal Engine's hardware occlusion query infrastructure. CesiumJS has no equivalent.

## Reference implementation: Cesium for Unreal

Per [Cesium's blog post (2022)](https://cesium.com/blog/2022/08/18/occlusion-culling-cesium-for-unreal/):

1. **Depth pre-pass.** Unreal renders a depth-only pass of already-visible occluders.
2. **Bounding box queries.** Each candidate tile's axis-aligned bounding box is rasterised against that depth buffer using Unreal's hardware occlusion query API. Zero pixels passing the depth test ⇒ tile is occluded.
3. **Two-level effect.**
   - **Renderer:** skip the draw call.
   - **Tile selection:** stop *refining* occluded subtrees. This is the major win — no network requests, no GPU uploads for descendants of an occluded tile.
4. **Conservative latency handling.** Queries are async (one-frame-or-more delay). Until a result returns, a previously-visible tile is assumed still visible to avoid one-frame holes during fast camera moves.

Reported savings:
- Ground-level dense urban navigation: **~31% tile load reduction**.
- Typical city exploration: **~17%**.
- Aerial / open scenes: minimal (few occluders).

Indoor scenes (high depth complexity, many opaque walls) sit at the upper end of this range — they're the best case for the technique.

## Why this isn't in CesiumJS

Two reasons, both surmountable:

1. **WebGL2 supports occlusion queries** (`ANY_SAMPLES_PASSED`, `OCCLUSION_QUERY_BOOLEAN`). Cesium's renderer is built on a WebGL2 abstraction. The primitive exists; Cesium just hasn't plumbed it into the tile selection traversal.
2. **Async query results are awkward to integrate** with a per-frame traversal. Solvable — Cesium for Unreal has solved it — but takes design work.

## Available approaches

Three options, in increasing engineering cost.

### Option A — Tileset structure fix (no Cesium changes)

If the tileset is generated as one large tile or a few coarse tiles, no engine on Earth can cull walls behind walls — there is nothing to cull.

The first thing to verify on any indoor tileset performance complaint is **tile granularity**. Re-export with smaller geometric error / tighter spatial subdivision so each room (or sub-room volume) becomes its own tile. Frustum culling — which CesiumJS already does — then handles the bulk of the savings for free, because most rooms are not in the view frustum at any one time.

- **Code coupling:** none.
- **Cesium-version risk:** none.
- **Cost:** depends on whether we control tileset generation.
- **Limit:** doesn't help when many tiles ARE in the frustum but mutually occlude each other.

This is the highest-leverage option for indoor scenes and should be tried first.

### Option B — Manual show/hide via `tileVisible` event (public API only)

Hook `tileset.tileVisible`, run a custom occlusion test (raycast from camera, BVH against precomputed visibility, portal graph between rooms), and set `tile.content.show = false` on tiles you determine are hidden.

- **Code coupling:** public API only (`tileVisible` event, `Cesium3DTileContent.show`).
- **Cesium-version risk:** very low. Public API has been stable for years. A breaking change would appear in upstream changelog.
- **Maintenance burden:** near zero.
- **Critical limitation:** suppresses *rendering only*. Cesium's traversal makes the refine/load decision *before* `tileVisible` fires. The tile is already loaded in memory, and its children may already be requested. **This option does NOT prevent loads** — it only saves draw calls and per-frame GPU work.

For the stated problem (geometry loading even when not visible), Option B does not help. Useful only when the bottleneck is rendering throughput rather than load throughput.

### Option C — Port Unreal's occlusion query approach to CesiumJS

The "real" implementation. Mirrors Cesium for Unreal:

1. Render a depth pre-pass of currently-loaded geometry (or reuse Cesium's existing depth target if accessible).
2. For each candidate tile due to be tested, submit a WebGL2 occlusion query rasterising the tile's bounding box.
3. Read back results 1+ frames later.
4. Inject results into Cesium's tile traversal so refinement halts on occluded subtrees.

Step 4 is the part with no public API. It requires touching `Cesium3DTilesetTraversal` (private). Three sub-options, all coupled:

- **C1 — patch the traversal class.** Fork or runtime-monkey-patch. Tightest coupling. Cesium has refactored the traversal substantially in the past (notably between 1.107 and ~1.115). Re-verification needed on every Cesium bump.
- **C2 — abuse public-ish hooks** (`cullRequestsWhileMoving`, SSE callbacks) in ways they weren't designed for. Slightly less brittle than C1 but relies on undocumented behavior.
- **C3 — subclass the traversal.** Cesium's class system isn't designed for this; ends up duplicating large amounts of upstream code.

- **Code coupling:** deep. All three sub-options touch private internals.
- **Cesium-version risk:** high. Expect a half-day to two-day re-verification each Cesium bump.
- **Cost:** ~2 weeks initial build. ~2–8 days/year ongoing maintenance.
- **Outcome:** matches Unreal's savings for indoor / dense scenes (~17–31% load reduction).

## Recommendation

In priority order:

1. **Try Option A first, always.** Tile granularity is almost always the dominant lever for indoor performance, and it's free of Cesium coupling. Verify by counting tiles in the problem dataset and inspecting average tile geometry size.
2. **Watch the Cesium roadmap.** Occlusion culling is queued upstream (issue #3241). If/when it ships natively, the maintenance treadmill of Option C disappears. Worth grepping their release notes 2–3 times a year for "occlusion."
3. **Only commit to Option C if (1) and (2) prove insufficient** and the performance gap is materially hurting the product. The maintenance cost is real and recurring; the cost of waiting for upstream is just patience.
4. **Skip Option B for the loading problem.** It doesn't address the stated bottleneck (loads). Reconsider only if we identify a separate problem where rendering throughput is the bottleneck and we already know which tiles are occluded.

## Open questions to investigate before starting Option C

- What does Cesium's render pipeline expose for accessing the depth buffer mid-frame? Does the public API permit a depth-only pre-pass without forking?
- How does the current `Cesium3DTilesetTraversal` make refinement decisions? What is the smallest patch surface that injects an "occluded" verdict?
- WebGL2 occlusion query latency on typical desktop hardware: is the 1–2 frame delay per tile budget acceptable for the tile candidate counts we care about?
- Does the bounding volume of a 3D Tile (often an oriented bounding box, sometimes a region) rasterise cheaply enough that we can issue one query per tile per frame for hundreds of candidates?

## Sources

- [Cesium 3D Tiles Roadmap — issue #3241](https://github.com/CesiumGS/cesium/issues/3241) — confirms occlusion culling is planned, not built, in CesiumJS.
- [Optimizing 3D Tiles Streaming in Cesium for Unreal with Occlusion Culling](https://cesium.com/blog/2022/08/18/occlusion-culling-cesium-for-unreal/) — reference implementation.
- [Hardware Occlusion Queries in Tileset Traversal — cesium-unreal issue #818](https://github.com/CesiumGS/cesium-unreal/issues/818) — the design discussion behind Unreal's implementation.
- [Cesium3DTileset API reference](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html) — `tileVisible` event for Option B.
- [Fast Hierarchical Culling — Cesium blog (2015)](https://cesium.com/blog/2015/08/04/fast-hierarchical-culling) — context on Cesium's existing frustum culling.
- [Occlusion culling — community thread (2024)](https://community.cesium.com/t/occlusion-culling/30824) — confirms ongoing user demand, no shipped solution.
