# Mixed Gaussian splat validation

Version 1.9.1 retains Cesium 1.142.0 and replaces its complete bundled distribution.
The source build applies the engine runtime correction range to pinned 1.142
source. Application and renderer dependencies continue to use Yarn 1.

## Build identity

- Upstream source: `3d07db311da7e96a4dc5f0ee2a1c8b15d4a408f5`.
- Correction base: `488b114e16f5879f5d51456640aae67850a715c0`.
- Correction: `9babb770321101c2685354bdcbf93429a9ddec9e`.
- Dependency lock SHA-256: `a23fa9719b8b77c3f88436e7ade167cd3e320b892de8ed9b855a7d99c98ba75d`.
- Cesium.js SHA-256: `c6dc367aaf1d97603be3161140f2e45c9a432a877e4658cef32a28b131986d80`.

The public source fetch, patch check, frozen npm install and upstream release
build pass with Node 22.22.2 and npm 10.9.7. The generated provenance lists all
392 distribution files. Every file hash matches in the preserved export,
application source and Linux package. Obsolete worker chunks are removed.
Build inputs and regression tools are excluded from the application package.

## Results on 192.168.8.212

Yarn installs, the renderer build, all 6 unit test files and Linux x64 packaging
pass. The dynamic multisampling pixel probe passes all four checks. It measures
298 blended pixels at rest, zero while moving, and 317 after stopping.

The real Electron viewer passes these eight cases with SwiftShader. Both color
variants pass rotation-centre picking and the splat measurement resolver.

| Layout | Splats | Basic-color pixels | Degree-3 pixels |
| --- | ---: | ---: | ---: |
| SPZ | 64 | 255239 | 253716 |
| Uncompressed | 64 | 255315 | 253795 |
| Mixed | 128 | 10304 | 10348 |
| Wide uncompressed fallback | 64 | 14408 | 12105 |

Pixel counts compare the drawn canvas with the tileset shown and hidden.
Degree-3 checks decode packed half-float coefficients. The 64-splat cases have
2,880 RGB values and 192 nonzero components. Mixed content has 5,760 values and
384 nonzero components. Each first RGB coefficient is `[0.5, 0.5, 0.5]`.

All cases preserve request-render mode, infinite idle time threshold and dynamic
multisampling. All cases retain an active default render loop and report no
render errors. The matrix does not request diagnostic frames during loading.

The original and clean rebuilt 1.142 controls render SPZ but fail uncompressed
and mixed content. The raw degree-3 control before the harmonic correction
renders 64 splats but loses all higher-order coefficients. These controls show
why visible pixels alone are insufficient.

## Repeat the browser regression

Build `web-page/app.js` first. Set `SPLAT_CASES` to a JSON array containing
`name`, `directory`, `expectedSplats`, `expectedSHDegree` and `expectedSHValue`.
The degree-3 fixtures use `expectedSHValue: 0.5`. Set `SPLAT_RESULTS` to a fresh
output directory, then run:

```bash
xvfb-run -a node_modules/.bin/electron tools/mixed-splats-verify.js
```

The shared test inputs remain on 192.168.8.212 under
`/mnt/data2/group4-consumers-20260908/fixtures-visual-v3` and
`/mnt/data2/group4-consumers-20260908/fixtures-sh3-v4`.
Raw logs, images and intermediate controls remain outside Git.

## Limits

The earlier wide-v2 fixture overflows the renderer's half-float covariance range
because its individual splats are too large. Wide-v3 retains the 9,000-unit
scene width with finite covariance. This change does not fix that separate
covariance limit. Windows and macOS packages were not built in this validation.
