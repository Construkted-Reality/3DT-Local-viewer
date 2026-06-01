/*eslint-env node*/
/* eslint-disable no-unused-vars */
/* eslint-disable global-require */

"use strict";

const servers = {};

// Register a single SIGINT handler once at module load. startServer used to
// add a fresh handler on every call, leaking listeners (MaxListenersExceeded
// after ~10 tileset selections) and retaining stale, already-closed servers.
process.on("SIGINT", function () {
    Object.keys(servers).forEach(function (id) {
        try {
            servers[id].close();
        } catch (e) {
            // already closed
        }
        delete servers[id];
    });
});

// Returns a Promise that resolves once the socket is actually listening and
// rejects (instead of killing the whole Electron process) on a bind error.
function startServer(id, port, dir) {
    if (servers[id]) {
        servers[id].close();
        delete servers[id];
    }

    const express = require("express");
    const compression = require("compression");
    const fs = require("fs");
    const url = require("url");
    const path = require("path");
    const gzipHeader = Buffer.from("1F8B08", "hex");
    const rootDir = path.resolve(dir);

    // eventually this mime type configuration will need to change
    // https://github.com/visionmedia/send/commit/d2cb54658ce65948b0ed6e5fb5de69d022bef941
    // *NOTE* Any changes you make here must be mirrored in web.config.
    const mime = express.static.mime;
    mime.define(
        {
            "application/json": ["czml", "json", "geojson", "topojson"],
            "application/wasm": ["wasm"],
            "image/crn": ["crn"],
            "image/ktx": ["ktx"],
            "model/gltf+json": ["gltf"],
            "model/gltf-binary": ["bgltf", "glb"],
            "application/octet-stream": [
                "b3dm",
                "pnts",
                "i3dm",
                "cmpt",
                "geom",
                "vctr",
            ],
            "text/plain": ["glsl"],
        },
        true
    );

    const app = express();
    app.use(compression());
    app.use(function (req, res, next) {
        res.header("Access-Control-Allow-Origin", "*");
        res.header(
            "Access-Control-Allow-Headers",
            "Origin, X-Requested-With, Content-Type, Accept"
        );
        next();
    });

    function checkGzipAndNext(req, res, next) {
        // Guard against next() being called more than once (data + end, or
        // error after data) which would corrupt the middleware chain.
        let advanced = false;
        function advance() {
            if (advanced) return;
            advanced = true;
            next();
        }

        const reqUrl = url.parse(req.url, true);

        // Resolve against the served directory, not the process cwd, and refuse
        // anything that escapes it. The previous code read relative to cwd, so
        // gzip detection never worked for the normal case (tileset dir !== cwd)
        // and pre-gzipped tilesets were served as raw gzip Cesium could not parse.
        let pathname;
        try {
            pathname = decodeURIComponent(reqUrl.pathname);
        } catch (e) {
            return advance();
        }
        const resolved = path.resolve(rootDir, "." + pathname);
        if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
            return advance();
        }

        const readStream = fs.createReadStream(resolved, { start: 0, end: 2 });
        readStream.on("error", function (err) {
            console.error("gzip sniff failed for", resolved, err.code || err.message);
            advance();
        });

        readStream.on("data", function (chunk) {
            if (chunk.equals(gzipHeader)) {
                res.header("Content-Encoding", "gzip");
            }
            advance();
        });

        // A zero-byte file emits 'end' with no 'data'/'error'; without this the
        // request would hang until the client times out.
        readStream.on("end", function () {
            advance();
        });
    }

    const knownTilesetFormats = [
        /\.b3dm/,
        /\.pnts/,
        /\.i3dm/,
        /\.cmpt/,
        /\.glb/,
        /\.geom/,
        /\.vctr/,
        /tileset.*\.json$/,
    ];

    app.get(knownTilesetFormats, checkGzipAndNext);

    app.use(express.static(dir));

    return new Promise(function (resolve, reject) {
        const server = app.listen(port, "localhost");
        servers[id] = server;

        server.on("listening", function () {
            console.log(
                "Tileset server running locally. Connect to http://localhost:%d/",
                server.address().port
            );
            resolve(server);
        });

        server.on("error", function (e) {
            delete servers[id];

            let message;
            if (e.code === "EADDRINUSE") {
                message = `Port ${port} is already in use. Another instance of the viewer may already be running.`;
            } else if (e.code === "EACCES") {
                message = `This process does not have permission to listen on port ${port}.`;
            } else {
                message = e.message;
            }

            console.error(e);
            reject(new Error(message));
        });

        server.on("close", function () {
            console.log("Tileset server stopped.");
        });
    });
}

function stopServer(id) {
    if (servers[id]) {
        servers[id].close();
        delete servers[id];
    }
}

module.exports = {
    startServer,
    stopServer
};
