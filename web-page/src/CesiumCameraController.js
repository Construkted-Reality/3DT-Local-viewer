import {
    Math as CesiumMath,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
} from "./CesiumJsInc.js";

const CAMERA_ANGLE_CHANGE_SPEED_HEADING = -60;
const CAMERA_ANGLE_CHANGE_SPEED_PITCH = -35;

import {validPitch} from "./validPitch.js"

class CesiumCameraController{
    constructor(options){
        this._isMobile = options.isMobile;
        this._enabled = false;

        this._cesiumViewer = options.cesiumViewer;
        this._canvas = this._cesiumViewer.canvas;
        this._camera = this._cesiumViewer.camera;
        this._speed = 1.0;

        /**
         * heading: angle with up direction
         * pitch:   angle with right direction
         * roll:    angle with look at direction
         */

        // indicate if heading and pitch is changed
        this._leftButtonPressed = false;
        this._cameraHeadingWhenLbuttonPressed = this._camera.heading;
        this._cameraPitchWhenLbuttonPressed = this._camera.pitch;

        this._startMousePosition = null;

        this._screenSpaceEventHandler = new ScreenSpaceEventHandler( this._canvas);

        this._screenSpaceEventHandler.setInputAction(this._onMouseLButtonDoubleClicked.bind(this), ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
        this._screenSpaceEventHandler.setInputAction(this._onMouseLButtonClicked.bind(this), ScreenSpaceEventType.LEFT_DOWN);
        this._screenSpaceEventHandler.setInputAction(this._onMouseUp.bind(this), ScreenSpaceEventType.LEFT_UP);
    }

    _onMouseLButtonDoubleClicked(movement) {

    }

    _onMouseLButtonClicked (movement) {
        if(this._isMobile)
            this._lastTapedPosition = movement.position;

        if(this._startFPVPositionMobile == null) {
            if(this._allowStartPositionTap)
                this._startFPVPositionMobile = movement.position.clone();
        }

        this._leftButtonPressed = true;
        this._cameraHeadingWhenLbuttonPressed = this._camera.heading;
        this._cameraPitchWhenLbuttonPressed = this._camera.pitch;
        this._startMousePosition = movement.position.clone();
    }

    _onMouseUp (position) {
        this._leftButtonPressed = false;
    }

    _onMouseMove (movement) {
        if(!this._leftButtonPressed)
            return;

        this._changeCameraHeadingPitch(movement.endPosition);
    }

    _changeCameraHeadingPitch (currentMousePosition) {
        const width = this._canvas.clientWidth;
        const height = this._canvas.clientHeight;

        const deltaX = (currentMousePosition.x - this._startMousePosition.x) / width;
        const deltaY = -(currentMousePosition.y - this._startMousePosition.y) / height;

        const deltaHeadingInDegree = (deltaX * CAMERA_ANGLE_CHANGE_SPEED_HEADING);
        const deltaPitchInDegree = (deltaY * CAMERA_ANGLE_CHANGE_SPEED_PITCH);

        this._camera.setView({
            orientation: {
                heading : this._cameraHeadingWhenLbuttonPressed + CesiumMath.toRadians(deltaHeadingInDegree),
                pitch : validPitch(this._cameraPitchWhenLbuttonPressed + CesiumMath.toRadians(deltaPitchInDegree)),
                roll : this._camera.roll
            }
        });
    }

    get speed(){
        return this._speed;
    }

    set speed(value) {
        this._speed = value;
    }

}

export {CesiumCameraController}