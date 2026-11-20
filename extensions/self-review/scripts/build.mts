import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distributionBuildId, normalizeDistributionLineEndings } from "./distribution-fingerprint.mjs";
import { publishDirectory } from "./publish-distribution.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const extensionRoot = path.join(repositoryRoot, "extensions", "self-review");
const distributionRoot = path.join(extensionRoot, "dist");
const toolsDistributionRoot = path.join(repositoryRoot, ".build", "extensions", "self-review");
const compiler = path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function distributionFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? distributionFiles(file) : [file];
    });
}

function build(staged: string) {
    const webOutput = path.join(staged, "web");
    for (const [project, output] of [
        ["tsconfig.node.build.json", staged],
        ["tsconfig.web.build.json", webOutput],
    ]) {
        execFileSync(process.execPath, [
            compiler, "-p", path.join(extensionRoot, project), "--outDir", output,
        ], { cwd: repositoryRoot, stdio: "inherit" });
    }

    for (const asset of ["index.html", "styles.css"]) {
        copyFileSync(path.join(extensionRoot, "web", asset), path.join(webOutput, asset));
    }
    for (const directory of ["bundled-skills", "review-commands"]) {
        cpSync(path.join(extensionRoot, directory), path.join(staged, directory), { recursive: true });
    }

    const marketplace: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, ".github", "plugin", "marketplace.json"), "utf8"));
    const selfReviewPlugin = isRecord(marketplace) && Array.isArray(marketplace.plugins)
        ? marketplace.plugins.find((plugin) => isRecord(plugin) && plugin.name === "self-review-canvas")
        : undefined;
    if (!isRecord(selfReviewPlugin) || typeof selfReviewPlugin.version !== "string" || !selfReviewPlugin.version.trim()) {
        throw new Error("The Self-Review plugin metadata has no valid version.");
    }
    const files = distributionFiles(staged);
    normalizeDistributionLineEndings(files);
    const buildId = distributionBuildId(staged, files);
    writeFileSync(path.join(staged, "version.json"), `${JSON.stringify({
        version: selfReviewPlugin.version,
        buildId,
    }, null, 2)}\n`);
}

const stagingRoot = mkdtempSync(path.join(repositoryRoot, ".build", "self-review-dist-"));
try {
    const staged = path.join(stagingRoot, "dist");
    const stagedTools = path.join(stagingRoot, "tools");
    build(staged);
    cpSync(staged, stagedTools, { recursive: true });
    const entry = path.join(stagingRoot, "extension.mjs");
    copyFileSync(path.join(extensionRoot, "extension.mjs"), entry);
    const toolsEntry = path.join(toolsDistributionRoot, "extension.mjs");
    if (!existsSync(toolsEntry) || !readFileSync(entry).equals(readFileSync(toolsEntry))) renameSync(entry, toolsEntry);
    publishDirectory(stagedTools, path.join(toolsDistributionRoot, "dist"));
    publishDirectory(staged, distributionRoot);
} finally {
    rmSync(stagingRoot, { recursive: true, force: true });
}
