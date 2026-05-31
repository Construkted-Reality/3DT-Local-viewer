// ABOUTME: Copies the Cesium3DTilesInspector-controlled display/debug settings from
// ABOUTME: one Cesium3DTileset to another so the inspector drives both compare sides.

// Tileset properties the Cesium3DTilesInspector writes when its controls change.
const TILESET_PROPERTIES = [
    "show",
    "style",
    "colorBlendMode",
    "maximumScreenSpaceError",
    "dynamicScreenSpaceError",
    "dynamicScreenSpaceErrorDensity",
    "dynamicScreenSpaceErrorFactor",
    "debugFreezeFrame",
    "debugWireframe",
    "debugShowBoundingVolume",
    "debugShowContentBoundingVolume",
    "debugShowViewerRequestVolume",
    "debugColorizeTiles",
    "debugShowGeometricError",
    "debugShowRenderingStatistics",
    "debugShowMemoryUsage",
    "debugShowUrl",
    "skipLevelOfDetail",
    "baseScreenSpaceError",
    "skipScreenSpaceErrorFactor",
    "skipLevels",
    "immediatelyLoadDesiredLevelOfDetail",
    "loadSiblings",
    "cullWithChildrenBounds",
    "cacheBytes",
];

// Nested pointCloudShading properties the inspector controls.
const POINT_CLOUD_SHADING_PROPERTIES = [
    "attenuation",
    "geometricErrorScale",
    "maximumAttenuation",
    "baseResolution",
    "eyeDomeLighting",
    "eyeDomeLightingStrength",
    "eyeDomeLightingRadius",
];

function copyIfChanged(source, target, prop) {
    const value = source[prop];
    if (value !== target[prop]) {
        target[prop] = value;
    }
}

function mirrorTilesetSettings(source, target) {
    if (!source || !target || source === target) return;

    for (const prop of TILESET_PROPERTIES) {
        copyIfChanged(source, target, prop);
    }

    if (source.pointCloudShading && target.pointCloudShading) {
        for (const prop of POINT_CLOUD_SHADING_PROPERTIES) {
            copyIfChanged(source.pointCloudShading, target.pointCloudShading, prop);
        }
    }
}

export {mirrorTilesetSettings};
