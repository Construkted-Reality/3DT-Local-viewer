window.addEventListener("DOMContentLoaded", () => {
    const menuButton = document.getElementById("menu-btn");
    const minimizeButton = document.getElementById("minimize-btn");
    const maxUnmaxButton = document.getElementById("max-unmax-btn");
    const closeButton = document.getElementById("close-btn");

    menuButton.addEventListener("click", e => {
        window.api.openMenu(e.x, e.y);
    });

    minimizeButton.addEventListener("click", () => {
        window.api.minimizeWindow();
    });

    maxUnmaxButton.addEventListener("click", async () => {
        const icon = maxUnmaxButton.querySelector("i.far");
        window.api.maxUnmaxWindow();
        const maximized = await window.api.isWindowMaximized();
        if (maximized) {
            icon.classList.remove("fa-square");
            icon.classList.add("fa-clone");
        } else {
            icon.classList.add("fa-square");
            icon.classList.remove("fa-clone");
        }
    });

    closeButton.addEventListener("click", () => {
        window.api.closeWindow();
    });

    document.querySelector('#select-3d-tileset').addEventListener('click', () => {
        window.api.selectTileset();
    });

    window.tilesetViewer.tilesetLoadError.addEventListener(() => {
        window.api.notifyTilesetLoadError();
    });
});
