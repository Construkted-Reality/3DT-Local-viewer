const MAX_PITCH_IN_DEGREE = 88;

function validPitch (pitch) {
    if( pitch > MAX_PITCH_IN_DEGREE * 2 && pitch < 360 - MAX_PITCH_IN_DEGREE) {
        pitch = 360 - MAX_PITCH_IN_DEGREE;
    }
    else {
        if (pitch > MAX_PITCH_IN_DEGREE && pitch < 360 - MAX_PITCH_IN_DEGREE) {
            pitch = MAX_PITCH_IN_DEGREE;
        }
    }

    return pitch;
}

export {validPitch}