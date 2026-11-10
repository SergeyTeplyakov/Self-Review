import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(extensionRoot, "..", "..");
const distributionRoot = path.join(extensionRoot, "dist");
const compiler = path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

function clearDirectory(directory) {
    mkdirSync(directory, { recursive: true });
    for (const entry of readdirSync(directory)) {
        rmSync(path.join(directory, entry), { recursive: true, force: true });
    }
}

mkdirSync(distributionRoot, { recursive: true });
const webOutput = path.join(distributionRoot, "web");
mkdirSync(webOutput, { recursive: true });
for (const entry of readdirSync(distributionRoot)) {
    const entryPath = path.join(distributionRoot, entry);
    if (entry === "web") clearDirectory(webOutput);
    else rmSync(entryPath, { recursive: true, force: true });
}

for (const project of ["tsconfig.node.build.json", "tsconfig.web.build.json"]) {
    execFileSync(process.execPath, [
        compiler,
        "-p",
        path.join("extensions", "self-review", project),
    ], { cwd: repositoryRoot, stdio: "inherit" });
}

mkdirSync(webOutput, { recursive: true });
const legacyLibrary = path.join(extensionRoot, "src", "lib");
for (const file of readdirSync(legacyLibrary)) {
    if (file.endsWith(".mjs")) copyFileSync(path.join(legacyLibrary, file), path.join(distributionRoot, "lib", file));
}
for (const asset of ["app.js", "index.html", "styles.css"]) {
    copyFileSync(path.join(extensionRoot, "web", asset), path.join(webOutput, asset));
}
