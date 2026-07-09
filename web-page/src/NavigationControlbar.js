import './NavigationControlbar.css'

class NavigationControlbar{
    constructor(options){
        const container = options.container;

        this._flyController = options.flyController;
        this._measureTool = options.measureTool;

        const flyButton = newButton('FLY', 'gwicon-baloon');

        flyButton.addEventListener('click', () =>{
            // Fly owns the camera and clicks; measurement can't run under it.
            deactivateMeasure();
            orbitButton.classList.remove('active');
            flyButton.classList.add('active');

            if (this._flyController.started()) {
                console.warn('already started');
                return;
            }

            this._flyController.start();
        });

        container.appendChild(flyButton);

        const orbitButton = newButton('ORBIT', 'gwicon-orbit');

        orbitButton.classList.add('active');

        orbitButton.addEventListener('click', () =>{
            deactivateMeasure();
            orbitButton.classList.add('active');

            flyButton.classList.remove('active');

            if (this._flyController.started()) {
                this._flyController.stop();
            }
        });

        container.appendChild(orbitButton);

        // MEASURE toggles a two-point distance overlay on top of the orbit camera. It is
        // mutually exclusive with fly (fly owns clicks), but drag-to-orbit still works while
        // measuring. No-op if no measure tool was supplied.
        const measureButton = newButton('MEASURE', 'gwicon-orbit');
        const deactivateMeasure = () => {
            if (this._measureTool && this._measureTool.isActive()) {
                this._measureTool.deactivate();
            }
            measureButton.classList.remove('active');
        };

        measureButton.addEventListener('click', () => {
            if (!this._measureTool) return;
            if (this._measureTool.isActive()) {
                deactivateMeasure();
                return;
            }
            // Measurement needs the orbit camera, not fly.
            if (this._flyController.started()) {
                this._flyController.stop();
                flyButton.classList.remove('active');
                orbitButton.classList.add('active');
            }
            this._measureTool.activate();
            measureButton.classList.add('active');
        });

        container.appendChild(measureButton);

        this._container = container;
    }

    show() {
        this._container.style.display = 'block';
    }

    hide() {
        this._container.style.display = 'none';
    }
}

function newButton(text,iconClass) {
    const button = document.createElement('button');
    let icon;
    if( iconClass != '' ) {
        icon = document.createElement('i');
        icon.className = iconClass;
    }

    button.type = "button";
    button.innerHTML = (icon ? icon.outerHTML : '') + text;
    button.className = "construkted-viewer-controlbar-button";

    return button;
}

export {NavigationControlbar}