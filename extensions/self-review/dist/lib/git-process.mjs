// Read-only Git process boundary shared by repository capture and settings identity.
import { execFile } from "node:child_process";
/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{allowFail?: boolean, input?: string}} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number | null}>}
 */
export function runGit(cwd, args, { allowFail = false, input } = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile("git", ["--no-pager", "-c", "core.quotepath=false", ...args], {
            cwd,
            maxBuffer: 256 * 1024 * 1024,
            windowsHide: true,
            encoding: "utf8",
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        }, (err, stdout, stderr) => {
            if (err && !allowFail) {
                reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim().split("\n").slice(0, 3).join(" ")}`));
                return;
            }
            resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "", exitCode: err ? typeof err.code === "number" ? err.code : null : 0 });
        });
        if (input !== undefined && child.stdin) {
            child.stdin.on("error", reject);
            child.stdin.end(input);
        }
    });
}
