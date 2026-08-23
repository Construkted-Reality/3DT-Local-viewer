// ABOUTME: One-off test runner for getAppVersion (no test framework in repo).
// ABOUTME: Run with `node src/appVersion.test.mjs`; exits non-zero on failure.
import {getAppVersion} from "./appVersion.js";

let failures = 0;
function check(name, condition) {
    if (condition) {
        console.log(`ok   - ${name}`);
    } else {
        console.error(`FAIL - ${name}`);
        failures++;
    }
}

// The module reads window.api, which the preload script creates. Node has no
// window, so each case builds one.
globalThis.window = {};

check("no api reads unknown", await getAppVersion() === "unknown");

globalThis.window = {api: {}};
check("an api without the method reads unknown", await getAppVersion() === "unknown");

globalThis.window = {api: {getAppVersion: async () => "1.6.0"}};
check("the version comes from the main process", await getAppVersion() === "1.6.0");

// A failed call must not leave the panel empty or throw into the caller.
const origError = console.error;
console.error = () => {};
globalThis.window = {api: {getAppVersion: async () => { throw new Error("no handler"); }}};
const onError = await getAppVersion();
console.error = origError;
check("a failed call reads unknown", onError === "unknown");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
