import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { safeJoin } from "./git.mjs";
function isMissing(error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR";
}
// Resolves a repository-relative path for the file manager. A path that no longer exists, such as a deleted
// file, falls back to its nearest existing folder, which is opened rather than selected. The containing folder
// is resolved through links, so a junction or directory symlink cannot reveal a location outside the repository.
export async function resolveRevealTarget(repoRoot, relPath) {
    if (!relPath || path.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
        throw new Error("Expected a repository-relative path.");
    }
    const root = await realpath(repoRoot);
    let candidate = safeJoin(root, relPath);
    let select = true;
    while (candidate !== root) {
        const parent = path.dirname(candidate);
        try {
            const checked = safeJoin(root, path.relative(root, path.join(await realpath(parent), path.basename(candidate))));
            const info = await lstat(checked);
            // Only a folder may be opened directly; opening a file would launch it in its default app.
            if (select || info.isDirectory())
                return { path: checked, select };
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
        }
        candidate = parent;
        select = false;
    }
    return { path: root, select: false };
}
function launch(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { ...options, detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}
function run(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { windowsHide: true, timeout: 10_000 }, (error) => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
}
// Shows the target in File Explorer, Finder, or the desktop's default file manager without a shell.
export function revealInFileManager({ path: target, select }) {
    if (process.platform === "win32") {
        // Explorer parses its own command line, so pass the path quoted verbatim (Windows paths cannot contain
        // double quotes) to keep commas in names intact. Explorer exits with 1 even on success, so a successful
        // launch is the only reliable signal.
        const explorer = path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
        return launch(explorer, [select ? `/select,"${target}"` : `"${target}"`], { windowsVerbatimArguments: true });
    }
    if (process.platform === "darwin")
        return run("/usr/bin/open", select ? ["-R", target] : [target]);
    if (process.platform === "linux")
        return launch("xdg-open", [select ? path.dirname(target) : target]);
    return Promise.reject(new Error("No file manager launcher is available on this platform."));
}
