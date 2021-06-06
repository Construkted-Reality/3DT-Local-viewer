import {config} from "./config.js"
import {overrideCesiumCamera} from "./overrideCesiumCamera";
import {TilesetViewer} from "./TilesetViewer";
import {initSidebar} from "./initSidebar";
import {initSettingsPopup} from "./initSettingsPopup";

console.log('TG Local viewer version', config.version);

initSidebar();
overrideCesiumCamera();

window.tilesetViewer = new TilesetViewer();

if (config.runMode === "web"){
    tilesetViewer.addTileset("https://s3.us-east-2.wasabisys.com/construkted-assets/aucbzxw01n/tileset.json");
}

initSettingsPopup();



