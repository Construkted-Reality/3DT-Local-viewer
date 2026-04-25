# Research: Cross-fade LOD transitions for 3D Tiles

**Date:** 2026-04-25
**Status:** Research complete; implementation deferred.
**Tracking:** No issue/branch yet.

## The problem

When the camera moves through a 3D tileset, CesiumJS swaps higher-resolution tiles into view abruptly. The transition from a coarse parent tile to a refined child tile is instantaneous, producing a visible "pop" that breaks immersion.

The built-in CesiumJS knobs that mitigate this (`skipLevelOfDetail = false`, `dynamicScreenSpaceError`, `preloadFlightDestinations`) only reduce the magnitude or change the timing of the pop. They do not produce a cross-fade. The product requirement is a real blend — old tile fades out while the new tile fades in over a short window (~0.5 s).

## The reference implementation

Cesium themselves have shipped this in **Cesium for Unreal**, not in CesiumJS. The technique is **dithered opacity masking**:

- Sample a tileable white-noise (or Bayer) texture in screen space.
- Threshold the noise against an animating alpha value (0 → 1 over the fade window).
- Discard fragments below threshold using the opaque pipeline (no translucency, no depth sort).
- The fading-*out* parent and fading-*in* child use **complementary** dither patterns. This means every screen-space pixel is covered by exactly one of the two tiles at every point during the fade — no gaps, no overdraw.

Why dithered, not translucent: dither stays on the opaque pipeline. Translucency in 3D tiles produces depth-sort artifacts, breaks occlusion culling, and is significantly more expensive at scale. Cesium's blog post calls this out explicitly.

Reference: https://cesium.com/blog/2022/10/20/smoother-lod-transitions-in-cesium-for-unreal/

## What CesiumJS gives us

### CustomShader API (Cesium3DTileset)

CesiumJS exposes `Cesium3DTileset({ customShader: ... })`, which injects user GLSL into the fragment stage of every tile's material. The shader can:

- Read fragment world / model / eye-space position.
- Read texture coordinates, normals, vertex colors, custom attributes.
- Read user-defined uniforms (scalars, vectors, matrices, sampler textures, booleans).
- Write `material.alpha`.
- Discard fragments.

This is enough to implement the dither shader half of the technique.

Reference: https://github.com/CesiumGS/cesium/blob/main/Documentation/CustomShaderGuide/README.md

### tileVisible event

`Cesium3DTileset.tileVisible` fires per visible tile per frame, after styling has been applied and before rendering. The handler receives the `Cesium3DTile` instance, from which you can reach `tile.content.model` (the underlying glTF model). The model has its own `.customShader`, `.color`, and similar mutable rendering state.

This is the hook that enables per-tile state.

Reference: https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html

## What CesiumJS does NOT give us

1. **Per-tile uniforms on the global tileset shader.** A `customShader` set on the tileset is shared across all tiles. To get per-tile fade alpha, you must attach a separate `CustomShader` instance to each tile's `content.model.customShader` (one shader-instance per tile).

2. **Parent-tile keep-alive during fade.** `Cesium3DTilesetTraversal` aggressively unloads / replaces a parent tile the moment its children are ready. Without intervention, the parent is gone before any cross-fade animation could play. This is the central engineering blocker — confirmed by Cesium developer Omar in 2018 (https://community.cesium.com/t/fade-in-transitions-for-3d-tiles/7490) and still unresolved upstream as of 2026-04.

3. **Reference implementation in CesiumJS.** No public example, plugin, or PR has shipped this. The 8-year gap since the feature was first requested is a strong signal that it is not trivial.

## Implementation plan (when we pick this up)

Recommended phasing — each phase ends in something demoable and de-risks the next.

### Phase 1 — Per-tile alpha plumbing (no dither yet)

Goal: prove we can drive a per-tile shader uniform from CPU-side load timing.

- Listen to `tileset.tileVisible`.
- Maintain a `Map<Cesium3DTile, { firstSeen: number }>` to record the first frame each tile became visible.
- On first visibility, attach a fresh `CustomShader` instance to `tile.content.model.customShader` with a uniform `u_fadeAlpha`.
- On every subsequent frame for that tile, recompute `u_fadeAlpha = clamp((now - firstSeen) / fadeDurationMs, 0, 1)` and update the uniform.
- Shader output: `material.alpha = u_fadeAlpha;` — translucent blend.

Cost: ~2–3 days, including tile eviction/reload edge cases.

Outcome: a working translucent fade-in (without parent keep-alive — parent will still pop out instantly). Lets us validate the per-tile machinery in isolation before committing to the dither + traversal work.

Known imperfection at this phase: depth-sort artifacts and overdraw, since translucent tiles don't compose cleanly with opaque scene geometry. Acceptable as a stepping stone, not as a ship.

### Phase 2 — Dither shader

Goal: replace the translucent alpha with the proper opaque-pipeline dither mask.

- Replace shader body with screen-space dither: `if (bayer4x4(gl_FragCoord.xy) > u_fadeAlpha) discard;`
- Add a tileset-wide bool uniform `u_isFadingOut` (or per-tile flag) so parent tiles can use the inverted threshold during their fade-out window.
- Verify no visible gaps or doubled-up pixels at the transition boundary by walking the camera through the tileset slowly.

Cost: ~1 day, given Phase 1 is solid.

Outcome: the fade-in side looks correct on the opaque pipeline. Still no parent-keep-alive — fade-out parents will not be visible for the duration of the fade because they are unloaded at child-ready time.

### Phase 3 — Parent keep-alive (the unknown)

This is the open-ended phase. Two architectural options, neither attempted:

**Option 3A — patch traversal.**
Fork or runtime-patch `Cesium3DTilesetTraversal` to delay the actual unload of a parent tile by `fadeDurationMs` worth of frames after its child becomes selected. Keep both rendered during that window. Hardest to maintain — Cesium upgrades will routinely require revalidation of the patch — but conceptually the cleanest match for the dithered approach.

**Option 3B — snapshot parent into a sibling primitive.**
At the moment a child tile is selected, copy the parent's geometry into a temporary `Primitive` outside the tileset's traversal control. Fade *that* out via Phase 2 shader. Original parent is allowed to unload normally. Less coupled to Cesium internals; more memory cost during fade; bookkeeping non-trivial when multiple LOD transitions overlap during a fast pan.

Cost: 3 days to 2 weeks depending on which option and how many edge cases bite. The cost variance here is the main reason this work is deferred — we don't know what we don't know yet.

## Risks and gotchas

- **Cesium-version coupling.** Anything touching `Cesium3DTilesetTraversal` (Phase 3A) couples this codebase to Cesium internals. Every Cesium bump requires re-verification. We currently track Cesium 1.140; upgrades happen.
- **Performance during fast camera moves.** Many tiles fading simultaneously could spike draw calls. Cesium for Unreal explicitly mitigates this; we'd need to too, likely by capping concurrent fades and instantly resolving the rest.
- **Custom attributes / metadata.** If we ever want per-tile custom shaders for *other* features (highlighting, classification, etc.), the per-tile shader instances added in Phase 1 need a clear extension story so we don't end up with multiple competing shader assignments on the same tile.
- **`Cesium3DTileset.tileVisible` fires every frame.** Per-tile uniform updates on hundreds of tiles per frame must be cheap (avoid object allocations in the hot path).
- **Tile eviction.** When tiles are evicted from the cache and reload, our `Map` needs to drop them, otherwise we'll attempt to update uniforms on disposed shader instances.
- **Parent keep-alive may double GPU memory** for the fade window's worth of overlapping LOD levels. Worth measuring on a representative tileset before committing.

## Decision

Deferred. The feature is achievable but not cheap, and the product can ship without it for now. Revisit when:

- A representative tileset on production hardware shows pop-in is materially hurting user experience, **or**
- A demo / sales context calls for visibly higher polish on transitions, **or**
- Cesium ships a built-in implementation upstream (worth periodically grepping their changelog for "LOD transition", "fade", or "dither").

## Sources

- [Smoother LOD Transitions in Cesium for Unreal with Dithered Opacity Masking](https://cesium.com/blog/2022/10/20/smoother-lod-transitions-in-cesium-for-unreal/) — the reference technique.
- [CesiumJS CustomShader Guide](https://github.com/CesiumGS/cesium/blob/main/Documentation/CustomShaderGuide/README.md) — the shader hook we'd build on.
- [Cesium3DTileset API (tileVisible)](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html) — the per-tile event hook.
- [Fade-in transitions for 3D Tiles — community thread, 2018](https://community.cesium.com/t/fade-in-transitions-for-3d-tiles/7490) — Cesium's own confirmation that no engine support exists, with the pointer to `Cesium3DTilesetTraversal`.
- [Modify 3DTile vertex shader — community thread](https://community.cesium.com/t/modify-3dtile-vertex-shader/18137) — confirms the global-shader limitation.
- [Custom shaders for models and 3D Tiles — GitHub issue #9518](https://github.com/CesiumGS/cesium/issues/9518) — historical context on the CustomShader API.
