// ABOUTME: One-off test runner for mirrorTilesetSettings (no test framework in repo).
// ABOUTME: Run with `node src/mirrorTilesetSettings.test.mjs`; exits non-zero on failure.
import {mirrorTilesetSettings} from "./mirrorTilesetSettings.js";

let failures = 0;
function check(name, condition) {
    if (condition) {
        console.log(`ok   - ${name}`);
    } else {
        console.error(`FAIL - ${name}`);
        failures++;
    }
}

// Builds a tileset-like object that records how many times each property is written.
function fakeTileset() {
    const writes = {};
    const backing = {
        maximumScreenSpaceError: 16,
        debugWireframe: false,
        debugShowBoundingVolume: false,
        show: true,
    };
    const pcsBacking = {attenuation: false, eyeDomeLighting: true};
    const wrap = (obj, counter) =>
        new Proxy(obj, {
            set(t, prop, value) {
                counter[prop] = (counter[prop] || 0) + 1;
                t[prop] = value;
                return true;
            },
        });
    const pcsWrites = {};
    writes.pointCloudShading = pcsWrites;
    const t = wrap(backing, writes);
    Object.defineProperty(t, "pointCloudShading", {
        value: wrap(pcsBacking, pcsWrites),
        enumerable: true,
    });
    t.__writes = writes;
    return t;
}

// copies a changed top-level property from source to target
const src = fakeTileset();
const dst = fakeTileset();
src.maximumScreenSpaceError = 4;
src.debugWireframe = true;
mirrorTilesetSettings(src, dst);
check("copies maximumScreenSpaceError", dst.maximumScreenSpaceError === 4);
check("copies debugWireframe", dst.debugWireframe === true);

// copies a changed nested pointCloudShading property
src.pointCloudShading.attenuation = true;
mirrorTilesetSettings(src, dst);
check("copies pointCloudShading.attenuation", dst.pointCloudShading.attenuation === true);

// does not write a property whose value already matches
const a = fakeTileset();
const b = fakeTileset();
mirrorTilesetSettings(a, b); // everything already equal
check("no redundant write when equal", (b.__writes.maximumScreenSpaceError || 0) === 0);

// no-op when source and target are the same object
const same = fakeTileset();
mirrorTilesetSettings(same, same);
check("no-op when source === target", (same.__writes.maximumScreenSpaceError || 0) === 0);

// no-op when either side is missing
mirrorTilesetSettings(undefined, dst);
mirrorTilesetSettings(src, undefined);
check("no-op when a side is missing", true);

if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
}
console.log("\nall tests passed");
