import {config} from "./config.js"
import {overrideCesiumCamera} from "./overrideCesiumCamera";
import {TilesetViewer} from "./TilesetViewer";
import {initSidebar} from "./initSidebar";
import {initSettingsPopup} from "./initSettingsPopup";

console.log('TG Local viewer version', config.version);

initSidebar();
overrideCesiumCamera();

window.tilesetViewer = new TilesetViewer();

initSettingsPopup();



