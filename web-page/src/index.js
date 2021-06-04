import {config} from "./config.js"
import {TilesetViewer} from "./TilesetViewer";

console.log('TG Local viewer version', config.version);

window.tilesetViewer = new TilesetViewer();

if (config.runMode === "web"){
    tilesetViewer.addTileset("https://s3.us-east-2.wasabisys.com/construkted-assets/aucbzxw01n/tileset.json");
}