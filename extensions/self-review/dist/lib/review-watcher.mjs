import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git-process.mjs";
const DEBOUNCE_MS = 350;
const gitInput = (name) => !name.endsWith(".lock")
    && (/^(HEAD|index|packed-refs|config|shallow|info\/exclude)$/.test(name) || name.startsWith("refs/")
        || (name.startsWith("modules/") && (/\/(HEAD|index|packed-refs|config|shallow|info\/exclude)$/.test(name) || name.includes("/refs/"))));
const message = (error) => error instanceof Error ? error.message : String(error);
function fileInventory(files) {
    const inventory = { files: new Set(files), directories: new Set() };
    for (const file of inventory.files) {
        let parent = path.posix.dirname(file);
        while (parent !== ".") {
            inventory.directories.add(parent);
            parent = path.posix.dirname(parent);
        }
    }
    return inventory;
}
function matchesPaths(inventories, paths) {
    return paths.some((file) => inventories.some((inventory) => inventory.files.has(file) || inventory.directories.has(file)));
}
const createDirectoryWatcher = (root, changed, failed) => {
    const watcher = watch(root, { recursive: true, persistent: false }, (event, file) => changed(file?.toString() ?? null, event));
    watcher.on("error", failed);
    return watcher;
};
// Each open panel owns one watcher; switching reviews or closing the panel releases it.
export class ReviewWatcher {
    service;
    log;
    debounceMs;
    watchDirectory;
    git;
    watchers = [];
    timer;
    generation = 0;
    reviewId = null;
    candidates = new Map();
    closed = false;
    running = Promise.resolve();
    constructor(service, log, debounceMs = DEBOUNCE_MS, watchDirectory = createDirectoryWatcher, git = runGit) {
        this.service = service;
        this.log = log;
        this.debounceMs = debounceMs;
        this.watchDirectory = watchDirectory;
        this.git = git;
    }
    async setReview(reviewId) {
        if (this.closed || this.reviewId === reviewId)
            return;
        this.release();
        this.reviewId = reviewId;
        const generation = this.generation;
        const signatures = new Map();
        try {
            const review = await this.service.getReview(reviewId);
            const submoduleInventory = async (submodule) => {
                const result = await runGit(path.join(review.repoRoot, submodule), ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
                return fileInventory(result.stdout.split("\0").filter(Boolean));
            };
            const inventory = async () => {
                const result = await runGit(review.repoRoot, ["ls-files", "--stage", "--cached", "--others", "--exclude-standard", "-z"]);
                const submodules = new Set();
                const files = [];
                for (const entry of result.stdout.split("\0").filter(Boolean)) {
                    const staged = /^(\d{6}) [0-9a-f]+ [0-3]\t([\s\S]*)$/.exec(entry);
                    const file = staged ? staged[2] : entry;
                    files.push(file);
                    if (staged?.[1] === "160000")
                        submodules.add(file);
                }
                return { ...fileInventory(files), submodules, submoduleFiles: new Map() };
            };
            const [dirs, initialFiles] = await Promise.all([
                runGit(review.repoRoot, ["rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"]),
                inventory(),
            ]);
            for (const [submodule, files] of await Promise.all([...initialFiles.submodules].map(async (submodule) => [submodule, await submoduleInventory(submodule)]))) {
                initialFiles.submoduleFiles.set(submodule, files);
            }
            let known = initialFiles;
            if (generation !== this.generation || this.closed)
                return;
            let eventVersion = 0;
            let needsRefresh = true;
            let ignoreEpoch = 0;
            const ignoredPaths = new Set();
            const unchecked = new Map();
            let pathVersion = 0;
            let classifying = false;
            const refresh = async (version) => {
                const isCurrent = () => generation === this.generation && !this.closed && eventVersion === version
                    && !classifying && !unchecked.size;
                if (!needsRefresh || !isCurrent())
                    return;
                await this.service.refresh(reviewId, isCurrent);
                if (isCurrent())
                    needsRefresh = false;
            };
            const ignoreLocation = (file) => {
                if (matchesPaths([known], [file]))
                    return null;
                let parent = path.posix.dirname(file);
                while (parent !== "." && !known.submodules.has(parent))
                    parent = path.posix.dirname(parent);
                const relative = parent === "." ? file : path.posix.relative(parent, file);
                const nested = known.submoduleFiles.get(parent);
                return nested && matchesPaths([nested], [relative]) ? null : { parent, relative };
            };
            const add = (root, metadata) => {
                const flush = () => {
                    this.timer = undefined;
                    const version = eventVersion;
                    const candidates = this.candidates;
                    this.candidates = new Map();
                    // Serialize checks as well as refreshes: read notifications must not race signature updates.
                    this.running = this.running.then(async () => {
                        if (generation !== this.generation || this.closed)
                            return;
                        let relevant = false;
                        let rescan = false;
                        const changedPaths = [];
                        const missingPaths = [];
                        for (const [absolute, candidate] of candidates) {
                            if (!candidate.file) {
                                relevant = true;
                                rescan = true;
                                continue;
                            }
                            const submoduleRoot = !candidate.git && known.submodules.has(candidate.file);
                            const file = await lstat(absolute).then((s) => ({
                                directory: s.isDirectory(),
                                signature: candidate.git && s.isDirectory() ? null : `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.mode}:${s.ino}`,
                            }), (error) => {
                                if (error.code === "ENOENT" || error.code === "ENOTDIR")
                                    return { directory: false, signature: "missing" };
                                throw error;
                            });
                            const { signature } = file;
                            if (signature === null || signatures.get(absolute) === signature)
                                continue;
                            signatures.set(absolute, signature);
                            // Recursive watchers can report child creation at the submodule directory itself.
                            // Its tracked/ignored content is checked through the nested Git inventory instead.
                            if (submoduleRoot && file.directory)
                                continue;
                            if (candidate.git) {
                                relevant = true;
                                continue;
                            }
                            changedPaths.push(candidate.file);
                            if (signature === "missing")
                                missingPaths.push(candidate.file);
                        }
                        if (changedPaths.length || rescan) {
                            // Keep the old inventory too, so deleting an untracked reviewed file still refreshes.
                            const nextRoot = await inventory();
                            const next = { ...nextRoot, submoduleFiles: new Map(known.submoduleFiles) };
                            for (const submodule of next.submodules) {
                                if (!next.submoduleFiles.has(submodule)) {
                                    next.submoduleFiles.set(submodule, await submoduleInventory(submodule));
                                }
                            }
                            if (matchesPaths([known, next], changedPaths))
                                relevant = true;
                            const submodulePaths = new Map();
                            for (const changed of changedPaths) {
                                let parent = path.posix.dirname(changed);
                                while (parent !== ".") {
                                    if (known.submodules.has(parent) || next.submodules.has(parent)) {
                                        const entries = submodulePaths.get(parent) ?? [];
                                        entries.push(path.posix.relative(parent, changed));
                                        submodulePaths.set(parent, entries);
                                        break;
                                    }
                                    parent = path.posix.dirname(parent);
                                }
                            }
                            for (const [submodule, paths] of submodulePaths) {
                                const previous = known.submoduleFiles.get(submodule) ?? fileInventory([]);
                                const current = next.submodules.has(submodule)
                                    ? await submoduleInventory(submodule)
                                    : undefined;
                                if (current)
                                    next.submoduleFiles.set(submodule, current);
                                if (previous && current && matchesPaths([previous, current], paths))
                                    relevant = true;
                                if (!next.submodules.has(submodule))
                                    next.submoduleFiles.delete(submodule);
                            }
                            if (!relevant) {
                                // A concurrent refresh may capture an untracked file before either inventory sees its deletion.
                                const missingByRoot = new Map();
                                for (const missing of missingPaths) {
                                    let submodule = path.posix.dirname(missing);
                                    while (submodule !== "." && !next.submodules.has(submodule))
                                        submodule = path.posix.dirname(submodule);
                                    const root = submodule === "." ? review.repoRoot : path.join(review.repoRoot, submodule);
                                    const relative = submodule === "." ? missing : path.posix.relative(submodule, missing);
                                    const paths = missingByRoot.get(root) ?? new Set();
                                    paths.add(relative);
                                    missingByRoot.set(root, paths);
                                }
                                for (const [root, paths] of missingByRoot) {
                                    const ignored = await runGit(root, ["check-ignore", "--no-index", "-z", "--stdin"], {
                                        allowFail: true,
                                        input: [...paths].join("\0") + "\0",
                                    });
                                    if (ignored.exitCode !== 0 && ignored.exitCode !== 1)
                                        throw new Error(`git check-ignore failed: ${ignored.stderr.trim() || `exit code ${ignored.exitCode}`}`);
                                    if (ignored.stdout.split("\0").filter(Boolean).length < paths.size) {
                                        relevant = true;
                                        break;
                                    }
                                }
                            }
                            known = next;
                        }
                        needsRefresh ||= relevant;
                        await refresh(version);
                    }).catch((error) => this.warn(error));
                };
                const schedule = () => {
                    clearTimeout(this.timer);
                    this.timer = setTimeout(flush, this.debounceMs);
                    this.timer.unref();
                };
                const admit = (file) => {
                    eventVersion++;
                    this.candidates.set(path.join(root, file), { file, git: metadata });
                    schedule();
                };
                const classify = async () => {
                    classifying = true;
                    try {
                        while (unchecked.size && generation === this.generation && !this.closed) {
                            const epoch = ignoreEpoch;
                            const groups = new Map();
                            for (const [file, version] of unchecked) {
                                const location = ignoreLocation(file);
                                if (!location) {
                                    unchecked.delete(file);
                                    admit(file);
                                    continue;
                                }
                                const group = groups.get(location.parent) ?? new Map();
                                group.set(location.relative, { file, version });
                                groups.set(location.parent, group);
                            }
                            const results = await Promise.all([...groups].map(async ([parent, files]) => {
                                try {
                                    const result = await this.git(path.join(root, parent), ["check-ignore", "-z", "--stdin"], {
                                        allowFail: true, input: [...files.keys()].join("\0") + "\0",
                                    });
                                    if (result.exitCode !== 0 && result.exitCode !== 1) {
                                        throw new Error(`git check-ignore failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
                                    }
                                    return [files, new Set(result.stdout.split("\0"))];
                                }
                                catch (error) {
                                    this.warn(error);
                                    return [files, new Set()];
                                }
                            }));
                            if (generation !== this.generation || this.closed)
                                return;
                            if (epoch !== ignoreEpoch)
                                continue;
                            for (const [files, ignored] of results) {
                                for (const [relative, { file, version }] of files) {
                                    if (unchecked.get(file) !== version)
                                        continue;
                                    unchecked.delete(file);
                                    if (ignored.has(relative)) {
                                        if (ignoredPaths.size >= 4096)
                                            ignoredPaths.delete(ignoredPaths.values().next().value);
                                        ignoredPaths.add(file);
                                    }
                                    else
                                        admit(file);
                                }
                            }
                        }
                    }
                    finally {
                        classifying = false;
                        // If the quiet timer already elapsed, classification was the only
                        // remaining publication barrier. Resume without another quiet period.
                        if (generation === this.generation && !this.closed && needsRefresh && !this.timer)
                            flush();
                    }
                };
                const watcher = this.watchDirectory(root, (filename, event) => {
                    if (generation !== this.generation || this.closed)
                        return;
                    const file = filename?.replace(/\\/g, "/") ?? "";
                    if (metadata ? file && !gitInput(file) : file.split("/").includes(".git"))
                        return;
                    if (metadata || !file || path.posix.basename(file) === ".gitignore") {
                        ignoreEpoch++;
                        ignoredPaths.clear();
                    }
                    else if (event === "rename") {
                        const affected = (candidate) => candidate === file || candidate.startsWith(`${file}/`);
                        for (const candidate of ignoredPaths)
                            if (affected(candidate))
                                ignoredPaths.delete(candidate);
                        for (const candidate of unchecked.keys())
                            if (affected(candidate))
                                unchecked.set(candidate, ++pathVersion);
                    }
                    if (metadata || !file || !ignoreLocation(file)) {
                        admit(file);
                    }
                    else if (!ignoredPaths.has(file)) {
                        if (!unchecked.has(file))
                            unchecked.set(file, ++pathVersion);
                        if (!classifying) {
                            classifying = true;
                            queueMicrotask(() => { void classify(); });
                        }
                    }
                }, (error) => {
                    this.warn(error);
                    watcher.close();
                });
                this.watchers.push(watcher);
            };
            add(review.repoRoot, false);
            for (const dir of new Set(dirs.stdout.trim().split(/\r?\n/)))
                add(dir, true);
            // Close the capture-to-watch gap, using the existing coalesced refresh.
            await refresh(eventVersion);
        }
        catch (error) {
            if (generation === this.generation) {
                this.release();
                this.warn(error);
            }
        }
    }
    warn(error) {
        this.log(`self-review: automatic refresh unavailable: ${message(error)}. Manual Refresh remains available.`, "warning");
    }
    release() {
        this.generation++;
        clearTimeout(this.timer);
        this.timer = undefined;
        for (const watcher of this.watchers)
            watcher.close();
        this.watchers = [];
        this.candidates.clear();
        this.reviewId = null;
    }
    async close() {
        this.closed = true;
        this.release();
        await this.running;
    }
}
