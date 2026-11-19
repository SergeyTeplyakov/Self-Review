import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function distributionFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? distributionFiles(file) : [file];
    });
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
cpSync(path.join(extensionRoot, "review-commands"), path.join(distributionRoot, "review-commands"), { recursive: true });

const marketplace: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, ".github", "plugin", "marketplace.json"), "utf8"));
const selfReviewPlugin = isRecord(marketplace) && Array.isArray(marketplace.plugins)
    ? marketplace.plugins.find((plugin) => isRecord(plugin) && plugin.name === "self-review-canvas")
    : undefined;
if (!isRecord(selfReviewPlugin) || typeof selfReviewPlugin.version !== "string" || !selfReviewPlugin.version.trim()) {
    throw new Error("The Self-Review plugin metadata has no valid version.");
}
const buildHash = createHash("sha256");
for (const file of distributionFiles(distributionRoot).sort()) {
    buildHash.update(path.relative(distributionRoot, file).split(path.sep).join("/")).update("\0");
    buildHash.update(readFileSync(file)).update("\0");
}
writeFileSync(path.join(distributionRoot, "version.json"), `${JSON.stringify({
    version: selfReviewPlugin.version,
    buildId: buildHash.digest("hex").slice(0, 12),
}, null, 2)}\n`);

mkdirSync(toolsDistributionRoot, { recursive: true });
rmSync(path.join(toolsDistributionRoot, "dist"), { recursive: true, force: true });
copyFileSync(path.join(extensionRoot, "extension.mjs"), path.join(toolsDistributionRoot, "extension.mjs"));
cpSync(distributionRoot, path.join(toolsDistributionRoot, "dist"), { recursive: true });
