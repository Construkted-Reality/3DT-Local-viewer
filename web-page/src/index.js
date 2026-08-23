import {getAppVersion} from "./appVersion.js"
import {overrideCesiumCamera} from "./overrideCesiumCamera";
import {TilesetViewer} from "./TilesetViewer";
import {initSidebar} from "./initSidebar";
import {initSettingsPopup} from "./initSettingsPopup";

getAppVersion().then((version) => console.log('TG Local viewer version', version));

initSidebar();
overrideCesiumCamera();

window.tilesetViewer = new TilesetViewer();

initSettingsPopup();



