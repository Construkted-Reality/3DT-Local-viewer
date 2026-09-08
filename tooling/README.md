# Cesium build inputs

The viewer uses Yarn 1 for its application and renderer dependencies. The separate
Cesium source export uses npm with `cesium-1.142.package-lock.json` copied to that
export's `package-lock.json`. Do not copy this lock into the viewer root.

This lock resolves Cesium 1.142.0 at commit
`3d07db311da7e96a4dc5f0ee2a1c8b15d4a408f5` from
`https://github.com/Construkted-Reality/cesium`.
Its SHA-256 is `a23fa9719b8b77c3f88436e7ade167cd3e320b892de8ed9b855a7d99c98ba75d`.

The frozen install passes on test server 192.168.8.212 with Node 22.22.2 and
npm 10.9.7. Use `CI=true npm ci --no-audit --no-fund` in the isolated
Cesium source export, with `HUSKY` unset. This keeps all upstream preparation
scripts enabled. CI mode skips browser system installation, while Husky reports
the absent Git directory in the source export normally.
Run compilation, tests and browser probes only on the test server.

## Rebuild the complete distribution

`cesium-build.json` pins the upstream source, the correction range and the build
tools. The build script exports upstream 1.142.0, applies only engine runtime
changes from the correction range, and runs the upstream release build.

On 192.168.8.212, use a new output directory:

```bash
node tools/build-cesium.js tooling/cesium-build.json /mnt/data2/cesium-build /mnt/data2/cesium-export
```

The export contains the full `Build/Cesium` distribution and
`build-provenance.json`. The provenance records the source commits, patch hash,
dependency lock hash and every generated file hash. Keep the export together:
the main bundle, workers and assets form one versioned artifact.

After validation, replace the tracked `web-page/Cesium-1.142/Build/Cesium`
directory with the complete export. Do not edit generated JavaScript or copy a
single bundle over workers from another build. The script retains its isolated
source directory so a reviewer can inspect the applied patch and build inputs.
