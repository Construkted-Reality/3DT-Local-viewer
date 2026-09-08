/*eslint-env node*/
"use strict";

// Export a complete Cesium distribution from pinned source and dependency inputs.
// Run upstream npm commands only in the isolated export, never in the viewer root.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {execFileSync} = require("child_process");

const [configuration, workspace, output] = process.argv.slice(2).map(value => path.resolve(value));
if (!configuration || !workspace || !output) {
    throw new Error("Usage: node tools/build-cesium.js CONFIG WORKSPACE NEW_OUTPUT_DIRECTORY");
}
const config = JSON.parse(fs.readFileSync(configuration, "utf8"));
for (const key of ["upstreamCommit", "correctionBaseCommit", "correctionCommit"]) {
    if (!/^[a-f0-9]{40}$/.test(config[key])) throw new Error(`Pin a full commit for ${key}`);
}
if (config.version !== "1.142.0") throw new Error("This export recipe targets Cesium 1.142.0");
if (fs.existsSync(output)) throw new Error("The output directory must be new");
const lock = path.resolve(path.dirname(configuration), config.dependencyLock);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
if (digest(fs.readFileSync(lock)) !== config.dependencyLockSha256) throw new Error("Dependency lock hash mismatch");
if (process.version !== `v${config.nodeVersion}`) throw new Error(`Use Node ${config.nodeVersion}`);
const npmVersion = execFileSync("npm", ["--version"], {encoding: "utf8"}).trim();
if (npmVersion !== config.npmVersion) throw new Error(`Use npm ${config.npmVersion}`);

fs.mkdirSync(workspace, {recursive: true});
const working = fs.mkdtempSync(path.join(workspace, "cesium-1.142-"));
const repository = path.join(working, "repository");
const source = path.join(working, "source");
const environment = {...process.env, CI: "true", GOMAXPROCS: "2", NODE_OPTIONS: "--max-old-space-size=2048"};
delete environment.HUSKY;
function run(command, args, cwd = working) {
    console.log(JSON.stringify({command, args, cwd}));
    execFileSync(command, args, {cwd, env: environment, stdio: "inherit"});
}

run("git", ["clone", "--filter=blob:none", "--no-checkout", "--depth=1", config.repository, repository]);
for (const commit of new Set([config.upstreamCommit, config.correctionBaseCommit, config.correctionCommit])) {
    run("git", ["fetch", "--depth=1", "origin", commit], repository);
}
const sourceArchive = path.join(working, "source.tar");
run("git", ["archive", "--format=tar", `--output=${sourceArchive}`, config.upstreamCommit], repository);
fs.mkdirSync(source);
run("tar", ["-xf", sourceArchive, "-C", source]);
const patch = execFileSync("git", ["diff", "--binary", config.correctionBaseCommit, config.correctionCommit,
    "--", "packages/engine/Source"], {cwd: repository, maxBuffer: 16 * 1024 * 1024});
if (!patch.length) throw new Error("The pinned correction has no engine runtime changes");
const patchPath = path.join(working, "runtime.patch");
fs.writeFileSync(patchPath, patch);
run("git", ["apply", "--check", patchPath], source);
run("git", ["apply", patchPath], source);
const exported = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
if (exported.version !== config.version) throw new Error("Exported source version mismatch");
fs.copyFileSync(lock, path.join(source, "package-lock.json"), fs.constants.COPYFILE_EXCL);
run("npm", ["ci", "--no-audit", "--no-fund"], source);
run("npm", ["run", "build-release"], source);
if (digest(fs.readFileSync(path.join(source, "package-lock.json"))) !== config.dependencyLockSha256) {
    throw new Error("The upstream build changed the dependency lock");
}

const distribution = path.join(source, "Build", "Cesium");
for (const entry of ["Cesium.js", "Workers", "Assets", "Widgets", "ThirdParty"]) {
    if (!fs.existsSync(path.join(distribution, entry))) throw new Error(`Missing distribution entry: ${entry}`);
}
const files = {};
function inventory(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) inventory(file, name);
        else if (entry.isFile()) files[name] = digest(fs.readFileSync(file));
        else throw new Error(`Distribution contains a non-regular entry: ${name}`);
    }
}
inventory(distribution);
fs.cpSync(distribution, output, {recursive: true, force: false, errorOnExist: true});
fs.writeFileSync(path.join(output, "build-provenance.json"), JSON.stringify({
    ...config, nodeVersion: process.version.slice(1), npmVersion,
    runtimePatchSha256: digest(patch), files
}, null, 2) + "\n");
console.log(JSON.stringify({output, working, files: Object.keys(files).length}));
