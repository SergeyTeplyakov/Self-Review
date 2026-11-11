// Read-only Git process boundary shared by repository capture and settings identity.
import { execFile } from "node:child_process";

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{allowFail?: boolean}} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export function runGit(cwd: string, args: string[], { allowFail = false }: { allowFail?: boolean } = {}): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
}> {
    return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve, reject) => {
        execFile(
            "git",
            ["--no-pager", "-c", "core.quotepath=false", ...args],
            {
                cwd,
                maxBuffer: 256 * 1024 * 1024,
                windowsHide: true,
                encoding: "utf8",
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
            },
            (err, stdout, stderr) => {
                if (err && !allowFail) {
                    reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim().split("\n").slice(0, 3).join(" ")}`));
                    return;
                }
                resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
            },
        );
    });
}
