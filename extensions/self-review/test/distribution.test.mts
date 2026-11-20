import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseExtensionVersion } from "../src/lib/extension-version.mjs";
import { distributionBuildId, normalizeDistributionLineEndings } from "../scripts/distribution-fingerprint.mjs";
import { publishDirectory } from "../scripts/publish-distribution.mjs";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));

async function filesUnder(directory: string): Promise<string[]> {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        files.push(...(entry.isDirectory() ? await filesUnder(file) : [file]));
    }
    return files;
}

test("distribution files and build IDs are stable across line endings and enumeration order", async (t) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "self-review-fingerprint-"));
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

    const linuxRoot = path.join(temporaryRoot, "linux");
    const windowsRoot = path.join(temporaryRoot, "windows");
    const relativeFiles = ["a1.txt", path.join("a", "file.txt")] as const;
    for (const root of [linuxRoot, windowsRoot]) {
        for (const relativeFile of relativeFiles) await mkdir(path.dirname(path.join(root, relativeFile)), { recursive: true });
    }
    await writeFile(path.join(linuxRoot, relativeFiles[0]), "first\nsecond\n");
    await writeFile(path.join(linuxRoot, relativeFiles[1]), "nested\ncontent\n");
    await writeFile(path.join(windowsRoot, relativeFiles[0]), "first\r\nsecond\r\n");
    await writeFile(path.join(windowsRoot, relativeFiles[1]), "nested\r\ncontent\r\n");

    const linuxFiles = relativeFiles.map((file) => path.join(linuxRoot, file));
    const windowsFiles = relativeFiles.map((file) => path.join(windowsRoot, file)).reverse();
    assert.equal(distributionBuildId(linuxRoot, linuxFiles), distributionBuildId(windowsRoot, windowsFiles));

    normalizeDistributionLineEndings(windowsFiles);
    assert.equal(await readFile(path.join(windowsRoot, relativeFiles[0]), "utf8"), "first\nsecond\n");
    assert.equal(await readFile(path.join(windowsRoot, relativeFiles[1]), "utf8"), "nested\ncontent\n");
});

for (const newType of ["directory", "file"] as const) {
    test(`publishing replaces an incompatible output with a ${newType}`, async (t) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "self-review-publish-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const staged = path.join(root, "staged");
        const dist = path.join(root, "dist");
        const target = path.join(dist, "artifact");
        const source = path.join(staged, "artifact");
        await mkdir(staged);
        await mkdir(dist);
        const newContents = "replacement\n";
        const oldContents = "obsolete\n";
        const directory = newType === "directory" ? source : target;
        const file = newType === "file" ? source : target;
        await mkdir(directory);
        await writeFile(path.join(directory, "child"), newType === "directory" ? newContents : oldContents);
        await writeFile(file, newType === "file" ? newContents : oldContents);

        publishDirectory(staged, dist);

        assert.deepEqual(await readdir(dist), ["artifact"]);
        if (newType === "directory") assert.deepEqual(await readdir(target), ["child"]);
        assert.equal(await readFile(newType === "directory" ? path.join(target, "child") : target, "utf8"), newContents);
    });
}

test("the installation-shaped distribution contains executable modules and all browser assets", async (t) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "self-review-package-"));
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

    const installedRoot = path.join(temporaryRoot, "self-review");
    const installedDist = path.join(installedRoot, "dist");
    await mkdir(installedRoot);
    await cp(path.join(extensionRoot, "extension.mjs"), path.join(installedRoot, "extension.mjs"));
    await cp(path.join(extensionRoot, "dist"), installedDist, { recursive: true });

    assert.deepEqual((await readdir(installedRoot)).sort(), ["dist", "extension.mjs"]);
    const installedFiles = await filesUnder(installedRoot);
    const installedPaths = new Set(installedFiles.map((file) => path.relative(installedRoot, file).replaceAll(path.sep, "/")));
    for (const file of [
        "dist/extension.mjs",
        "dist/lib/server.mjs",
        "dist/lib/settings.mjs",
        "dist/version.json",
        "dist/review-commands/explain/SKILL.md",
        "dist/review-commands/learn/SKILL.md",
        "dist/web/app.js",
        "dist/web/contracts.mjs",
        "dist/web/index.html",
        "dist/web/settings-api.mjs",
        "dist/web/styles.css",
    ]) assert.ok(installedPaths.has(file), `missing installed file ${file}`);

    const extensionVersion = parseExtensionVersion(JSON.parse(await readFile(path.join(installedDist, "version.json"), "utf8")) as unknown);
    assert.match(extensionVersion.version, /^\d+\.\d+\.\d+$/);
    assert.match(extensionVersion.buildId, /^[a-f0-9]{12}$/);

    for (const file of installedFiles.filter((candidate) => candidate.endsWith(".mjs"))) {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    }

    for (const file of installedFiles.filter((candidate) => /\.(?:mjs|js)$/.test(candidate))) {
        const source = await readFile(file, "utf8");
        for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
            const specifier = match[1];
            if (!specifier) continue;
            const dependency = fileURLToPath(new URL(specifier, pathToFileURL(file)));
            await stat(dependency);
        }
    }

    const html = await readFile(path.join(installedDist, "web", "index.html"), "utf8");
    assert.match(html, /href="styles\.css"/);
    assert.match(html, /src="app\.js"/);

    const { reviewOptions } = await import(pathToFileURL(path.join(installedDist, "web", "contracts.mjs")).href);
    assert.deepEqual(reviewOptions({ models: ["model-a"], focus: "both" }), {
        models: ["model-a"], focus: "both", intent: "",
    });
    assert.throws(() => reviewOptions({ models: ["model-a"], focus: "unsupported" }), /focus must be/);

    const { reviewCommandGuidance }: typeof import("../src/lib/review-command-skills.mjs") =
        await import(pathToFileURL(path.join(installedDist, "lib", "review-command-skills.mjs")).href);
    const learnDoc = path.join(installedDist, "review-commands", "learn", "SKILL.md");
    const markdown = await readFile(learnDoc, "utf8");
    await writeFile(learnDoc, markdown.replace("## Auto-save on", "## Auto-save on\n\nFixture-only guidance."));
    assert.match(reviewCommandGuidance("/learn", "m-test", true, "repo.md", "personal.md").join("\n"), /Fixture-only guidance\./);
    assert.doesNotMatch(reviewCommandGuidance("/learn", "m-test", false, "repo.md", "personal.md").join("\n"), /Fixture-only guidance\./);
});
