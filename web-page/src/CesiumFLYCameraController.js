/*
 sandcastle sample

 https://sandcastle.cesium.com/?src=Camera%20Tutorial.html
*/

import {ScreenSpaceEventType} from "./CesiumJsInc.js";
import {CesiumCameraController} from "./CesiumCameraController.js";
import {disableDefaultScreenSpaceCameraController} from "./util";
import {enableDefaultScreenSpaceCameraController} from "./util";

/*global Cesium*/

let flags = {
    moveForward: false,
    moveBackward: false,
    moveUp: false,
    moveDown: false,
    moveLeft: false,
    moveRight: false,
};

const defaultFLYSpeed = 2;

const testOnLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

class CesiumFLYCameraController extends CesiumCameraController{
    constructor(options){
        super(options);

        this._started = false;
        this._moveRateFactor = 0.4;

        const self = this;

        document.addEventListener(
            "keydown",
            function (e) {
                if(e.shiftKey)
                    self.speed = 3;
                else
                    self.speed = 1;

                const flagName = getFlagForKeyCode(e.keyCode);

                if (typeof flagName !== "undefined") {
                    flags[flagName] = true;
                }
            },
            false
        );

        document.addEventListener(
            "keyup",
            function (e) {
                const flagName = getFlagForKeyCode(e.keyCode);
                if (typeof flagName !== "undefined") {
                    flags[flagName] = false;
                }
            },
            false
        );

        const viewer = this._cesiumViewer;
        const canvas = viewer.canvas;

        canvas.setAttribute("tabindex", "0"); // needed to put focus on the canvas
        canvas.onclick = function () {
            canvas.focus();
        };

        viewer.clock.onTick.addEventListener( (clock) => {
            if(!this._started)
                return;

            let camera = viewer.camera;

            let moveRate = defaultFLYSpeed * this._moveRateFactor * this.speed;

            if (flags.moveForward) {
                camera.moveForward(moveRate);
            }
            if (flags.moveBackward) {
                camera.moveBackward(moveRate);
            }
            if (flags.moveUp) {
                camera.moveUpEx(moveRate);
            }
            if (flags.moveDown) {
                camera.moveDownEx(moveRate);
            }
            if (flags.moveLeft) {
                camera.moveLeft(moveRate);
            }
            if (flags.moveRight) {
                camera.moveRight(moveRate);
            }
        });
    }


    start(){
        disableDefaultScreenSpaceCameraController(this._cesiumViewer.scene);
        this._started = true;

        this._screenSpaceEventHandler.setInputAction(this._onMouseMove.bind(this), ScreenSpaceEventType.MOUSE_MOVE);
    }

    stop(){
        enableDefaultScreenSpaceCameraController(this._cesiumViewer.scene);
        this._started = false;

        this._screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.MOUSE_MOVE);
    }

    started() {
        return this._started;
    }

    setMoveRateFactor(n){
        this._moveRateFactor = n;
    }
}

function getFlagForKeyCode(keyCode) {
    switch (keyCode) {
        case "W".charCodeAt(0):
            return "moveForward";
        case "S".charCodeAt(0):
            return "moveBackward";
        case "R".charCodeAt(0):
            return "moveUp";
        case "F".charCodeAt(0):
            return "moveDown";
        case "D".charCodeAt(0):
            return "moveRight";
        case "A".charCodeAt(0):
            return "moveLeft";
        default:
            return undefined;
    }
}

export {CesiumFLYCameraController}