import {Math as CesiumMath} from "./CesiumJsInc.js";

const MAX_PITCH_IN_DEGREE = 88;
const MAX_PITCH_IN_RADIANS = CesiumMath.toRadians(MAX_PITCH_IN_DEGREE);

// `pitch` arrives as a signed radian value (Cesium camera.pitch ∈ ~[-π/2, π/2]).
// Clamp symmetrically so the camera cannot pitch past ±88° and gimbal-flip.
function validPitch (pitch) {
    return CesiumMath.clamp(pitch, -MAX_PITCH_IN_RADIANS, MAX_PITCH_IN_RADIANS);
}

export {validPitch}
