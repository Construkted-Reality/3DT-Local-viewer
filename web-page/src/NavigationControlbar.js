import './NavigationControlbar.css'

class NavigationControlbar{
    constructor(options){
        const container = options.container;

        this._flyController = options.flyController;

        const flyButton = newButton('FLY', 'gwicon-baloon');

        flyButton.addEventListener('click', () =>{
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
            orbitButton.classList.add('active');

            flyButton.classList.remove('active');

            if (this._flyController.started()) {
                this._flyController.stop();
            } else {
                // do nothing
            }
        });

        container.appendChild(orbitButton);

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
    button.innerHTML = icon.outerHTML + text;
    button.className = "construkted-viewer-controlbar-button";

    return button;
}

export {NavigationControlbar}