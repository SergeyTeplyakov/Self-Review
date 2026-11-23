import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Manifest = Record<string, string>;
type Snapshot = { exists: boolean; files: Manifest };
type Operation = "deploy" | "verify" | "restore";
export type Options = {
    operation: Operation;
    checkout: string;
    install: string;
    data: string;
    receipt: string;
    backup?: string;
    url?: string;
};

function canonical(file: string): string {
    const absolute = path.resolve(file);
    if (existsSync(absolute)) return realpathSync(absolute);
    const parent = path.dirname(absolute);
    if (parent === absolute) throw new Error(`Cannot resolve path: ${file}`);
    return path.join(canonical(parent), path.basename(absolute));
}

function overlaps(a: string, b: string): boolean {
    const relative = path.relative(a, b);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function disjoint(a: string, b: string): boolean {
    return !overlaps(a, b) && !overlaps(b, a);
}

function snapshot(root: string): Snapshot {
    if (!existsSync(root)) return { exists: false, files: {} };
    const files: Manifest = Object.create(null);
    function walk(directory: string): void {
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}`);
        for (const entry of readdirSync(directory).sort()) {
            const file = path.join(directory, entry);
            const stat = lstatSync(file);
            if (stat.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${file}`);
            if (stat.isDirectory()) walk(file);
            else if (stat.isFile()) files[path.relative(root, file).split(path.sep).join("/")] = createHash("sha256").update(readFileSync(file)).digest("hex");
            else throw new Error(`Unsupported filesystem entry: ${file}`);
        }
    }
    walk(root);
    return { exists: true, files };
}

function same(a: Snapshot, b: Snapshot): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function optionalVersion(dist: string): string | null {
    let text: string;
    try {
        text = readFileSync(path.join(dist, "version.json"), "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
    }
    if (typeof value !== "object" || value === null || !("buildId" in value) ||
        typeof value.buildId !== "string" || !value.buildId) return null;
    return value.buildId;
}

function version(dist: string): string {
    const buildId = optionalVersion(dist);
    if (!buildId) throw new Error(`Missing or invalid build ID in ${dist}`);
    return buildId;
}

function requireSame(expected: Snapshot, actual: Snapshot, what: string): void {
    if (!expected.exists || !same(expected, actual)) throw new Error(`${what} hash mismatch`);
}

function verifiedBackup(backup: string): Snapshot {
    const expected: unknown = JSON.parse(readFileSync(path.join(backup, "manifest.json"), "utf8"));
    const actual = snapshot(path.join(backup, "dist"));
    if (JSON.stringify(expected) !== JSON.stringify(actual) || !actual.exists) throw new Error("Backup hash mismatch");
    version(path.join(backup, "dist"));
    return actual;
}

function replaceDist(install: string, source: string, expected: Snapshot): void {
    const target = path.join(install, "dist");
    const staging = mkdtempSync(path.join(install, ".self-review-deploy-"));
    const staged = path.join(staging, "new");
    const previous = path.join(staging, "previous");
    let moved = false;
    let installed = false;
    try {
        cpSync(source, staged, { recursive: true, errorOnExist: true });
        requireSame(expected, snapshot(staged), "Staged distribution");
        if (existsSync(target)) {
            renameSync(target, previous);
            moved = true;
        }
        try {
            renameSync(staged, target);
            installed = true;
            requireSame(expected, snapshot(target), "Installed distribution");
        } catch (error) {
            try {
                if (installed) rmSync(target, { recursive: true });
                if (moved) {
                    renameSync(previous, target);
                    moved = false;
                }
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], `Install failed and rollback failed; previous distribution remains at ${previous}`);
            }
            throw error;
        }
        if (moved) {
            rmSync(previous, { recursive: true });
            moved = false;
        }
    } finally {
        // Keep the previous distribution if rollback itself failed.
        if (!moved) rmSync(staging, { recursive: true, force: true });
    }
}

export async function run(options: Options, checkBuild?: () => void): Promise<void> {
    if (existsSync(options.install) && lstatSync(options.install).isSymbolicLink()) throw new Error("Installation must not be a symlink");
    const checkout = canonical(options.checkout);
    const install = canonical(options.install);
    const data = canonical(options.data);
    const receipt = canonical(options.receipt);
    const backup = options.backup ? canonical(options.backup) : undefined;
    if (!disjoint(install, data) || !disjoint(receipt, install) || !disjoint(receipt, data) ||
        !disjoint(checkout, install) || !disjoint(checkout, data) || !disjoint(receipt, checkout) ||
        (backup && (![checkout, install, data, receipt].every((item) => disjoint(backup, item))))) {
        throw new Error("Checkout, installation, data, backup, and receipt paths must not overlap.");
    }
    if (options.operation !== "verify" && !backup) throw new Error("--backup is required for deploy and restore");
    if (options.operation !== "verify" && options.url) throw new Error("--url is only supported for verify");
    const dist = path.join(install, "dist");
    const built = path.join(checkout, "extensions", "self-review", "dist");
    const startedAt = new Date().toISOString();
    const dataBefore = snapshot(data);
    const before = snapshot(dist);
    if (!before.exists && options.operation !== "restore") throw new Error("Installed dist is missing");
    const buildIdBefore = options.operation === "restore" ? optionalVersion(dist) : version(dist);
    const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    // Reserve the receipt before any mutation; never overwrite another run.
    writeFileSync(receipt, "", { flag: "wx" });
    let error: unknown;
    let buildIdAfter: string | null = null;
    let installedAfter: Snapshot | null = null;
    let dataAfter: Snapshot | null = null;
    let sourceManifest: Snapshot | null = null;
    let providerBuildId: string | null = null;
    try {
        if (options.operation === "deploy") {
            if (existsSync(backup!)) throw new Error("Backup already exists");
            if (!existsSync(built)) throw new Error("Checkout distribution is missing");
            if (checkBuild) checkBuild();
            else {
                execFileSync(process.execPath, [path.join(checkout, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.tools.json"], { cwd: checkout, stdio: "inherit" });
                const result = spawnSync(process.execPath, [path.join(checkout, ".build", "extensions", "self-review", "scripts", "build.mjs"), "--check"], { cwd: checkout, encoding: "utf8" });
                if (result.error) throw result.error;
                if (result.status !== 0) throw new Error(`Build freshness check failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
            }
            sourceManifest = snapshot(built);
            version(built);
            mkdirSync(backup!);
            cpSync(dist, path.join(backup!, "dist"), { recursive: true, errorOnExist: true });
            requireSame(before, snapshot(path.join(backup!, "dist")), "Backup");
            writeFileSync(path.join(backup!, "manifest.json"), `${JSON.stringify(before, null, 2)}\n`, { flag: "wx" });
            replaceDist(install, built, sourceManifest);
        } else if (options.operation === "restore") {
            sourceManifest = verifiedBackup(backup!);
            replaceDist(install, path.join(backup!, "dist"), sourceManifest);
        } else {
            const reference = backup ? path.join(backup, "dist") : built;
            sourceManifest = backup ? verifiedBackup(backup) : snapshot(built);
            requireSame(sourceManifest, before, "Installed distribution");
            const expectedBuildId = version(reference);
            if (options.url) {
                const stateUrl = new URL(options.url);
                stateUrl.pathname = "/api/state";
                stateUrl.hash = "";
                const response = await fetch(stateUrl, { signal: AbortSignal.timeout(10_000) });
                if (!response.ok) throw new Error(`Provider state returned HTTP ${response.status}`);
                const state: unknown = await response.json();
                if (typeof state !== "object" || state === null || !("extensionVersion" in state) ||
                    typeof state.extensionVersion !== "object" || state.extensionVersion === null ||
                    !("buildId" in state.extensionVersion) || typeof state.extensionVersion.buildId !== "string") {
                    throw new Error("Provider state has no build ID");
                }
                providerBuildId = state.extensionVersion.buildId;
                if (providerBuildId !== expectedBuildId) throw new Error("Provider build ID mismatch");
            }
        }
    } catch (caught) {
        error = caught;
    } finally {
        try {
            dataAfter = snapshot(data);
            installedAfter = snapshot(dist);
            buildIdAfter = error && options.operation === "restore" ? optionalVersion(dist) : version(dist);
            if (!same(dataBefore, dataAfter)) throw new Error("Data directory changed during operation");
            if (!error && options.operation === "verify" && sourceManifest) requireSame(sourceManifest, installedAfter, "Installed distribution");
        } catch (caught) {
            error = error ? new AggregateError([error, caught], "Operation and final verification failed") : caught;
        }
        writeFileSync(receipt, `${JSON.stringify({
            operation: options.operation, startedAt, finishedAt: new Date().toISOString(), checkout, commit,
            install, data, backup: backup ?? null, buildIdBefore, buildIdAfter, providerBuildId,
            sourceManifest, installedBefore: before, installedAfter, dataBefore, dataAfter,
            dataChanged: dataAfter ? !same(dataBefore, dataAfter) : null,
            error: error instanceof Error ? error.message : error ? String(error) : null,
        }, null, 2)}\n`);
    }
    if (error) throw error;
    if (options.operation === "deploy") console.log("Reload the provider, then run verify with --url to check the served build ID.");
    if (options.operation === "restore") console.log("Reload the provider, then run verify with --backup and --url to check the restored build ID.");
}

function parseArgs(args: string[]): Options {
    const operation = args.shift();
    if (operation !== "deploy" && operation !== "verify" && operation !== "restore") {
        throw new Error("Usage: deploy|verify|restore --receipt PATH [--checkout PATH] [--install PATH] [--data PATH] [--backup PATH] [--url URL]");
    }
    const values = new Map<string, string>();
    while (args.length) {
        const key = args.shift()!;
        const value = args.shift();
        if (!["--checkout", "--install", "--data", "--receipt", "--backup", "--url"].includes(key) || !value || value.startsWith("--") || values.has(key)) throw new Error(`Invalid argument: ${key}`);
        values.set(key, value);
    }
    const receipt = values.get("--receipt");
    if (!receipt) throw new Error("--receipt is required");
    return {
        operation, receipt, checkout: values.get("--checkout") ?? process.cwd(),
        install: values.get("--install") ?? path.join(os.homedir(), ".copilot", "extensions", "self-review"),
        data: values.get("--data") ?? path.join(os.homedir(), ".copilot", "extension-data", "self-review"),
        backup: values.get("--backup"), url: values.get("--url"),
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    run(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
