/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.142.0
 *
 * Copyright 2011-2022 Cesium Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Columbus View (Pat. Pend.)
 *
 * Portions licensed separately.
 * See https://github.com/CesiumGS/cesium/blob/main/LICENSE.md for full licensing details.
 */

import{a as f}from"./chunk-DLLM46SE.js";import"./chunk-QWM27W75.js";import"./chunk-TLKR7ALY.js";import{a as u}from"./chunk-EVVIZTSX.js";import"./chunk-OAADA6GG.js";import"./chunk-4VGTRTOA.js";import"./chunk-GTOKGMXD.js";import"./chunk-MGGRO6QG.js";import"./chunk-YEZL4HSR.js";import"./chunk-X3KOJTC5.js";import"./chunk-TTSA6MXQ.js";import"./chunk-KLPQYGKM.js";import"./chunk-2VQFBEZY.js";import"./chunk-6LZUEMFX.js";import"./chunk-PTFUUUZZ.js";import"./chunk-XVQWWMC3.js";import"./chunk-UQIJT5PP.js";import"./chunk-LKQXJXNV.js";import"./chunk-WGMOHJAM.js";import"./chunk-ASL6PLG5.js";import"./chunk-ID4I2XFJ.js";import"./chunk-GPPK6KEE.js";import"./chunk-77FXKY6N.js";import"./chunk-ROLZVYOZ.js";function h(c,d){let e=f.upsampleMesh(c),t=e.vertices.buffer,i=e.indices.buffer,s=e.westIndicesSouthToNorth.buffer,o=e.southIndicesEastToWest.buffer,r=e.eastIndicesNorthToSouth.buffer,n=e.northIndicesWestToEast.buffer;return d.push(t,i,s,o,r,n),{verticesBuffer:t,indicesBuffer:i,vertexCountWithoutSkirts:e.vertexCountWithoutSkirts,indexCountWithoutSkirts:e.indexCountWithoutSkirts,encoding:e.encoding,westIndicesBuffer:s,southIndicesBuffer:o,eastIndicesBuffer:r,northIndicesBuffer:n,minimumHeight:e.minimumHeight,maximumHeight:e.maximumHeight,boundingSphere:e.boundingSphere3D,orientedBoundingBox:e.orientedBoundingBox,horizonOcclusionPoint:e.horizonOcclusionPoint}}var I=u(h);export{I as default};
