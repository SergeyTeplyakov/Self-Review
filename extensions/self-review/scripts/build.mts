import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const extensionRoot = path.join(repositoryRoot, "extensions", "self-review");
const distributionRoot = path.join(extensionRoot, "dist");
const toolsDistributionRoot = path.join(repositoryRoot, ".build", "extensions", "self-review");
const compiler = path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

function clearDirectory(directory: string) {
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
for (const asset of ["index.html", "styles.css"]) {
    copyFileSync(path.join(extensionRoot, "web", asset), path.join(webOutput, asset));
}
cpSync(path.join(extensionRoot, "bundled-skills"), path.join(distributionRoot, "bundled-skills"), { recursive: true });

mkdirSync(toolsDistributionRoot, { recursive: true });
rmSync(path.join(toolsDistributionRoot, "dist"), { recursive: true, force: true });
copyFileSync(path.join(extensionRoot, "extension.mjs"), path.join(toolsDistributionRoot, "extension.mjs"));
cpSync(distributionRoot, path.join(toolsDistributionRoot, "dist"), { recursive: true });
