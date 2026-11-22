// Read-only Git process boundary shared by repository capture and settings identity.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function readGitBlob(cwd: string, oid: string, maxBytes: number): Promise<Buffer | null> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error("Expected a full Git object ID.");
    try {
        const { stdout } = await promisify(execFile)("git", ["cat-file", "blob", oid], {
            cwd, encoding: "buffer", maxBuffer: maxBytes, windowsHide: true,
            env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
        });
        return stdout;
    } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === 128 || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) return null;
        throw error;
    }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{allowFail?: boolean, input?: string}} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number | null}>}
 */
export function runGit(cwd: string, args: string[], { allowFail = false, input }: { allowFail?: boolean; input?: string } = {}): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}> {
    return new Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
        const child = execFile(
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
                resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "", exitCode: err ? typeof err.code === "number" ? err.code : null : 0 });
            },
        );
        if (input !== undefined && child.stdin) {
            child.stdin.on("error", reject);
            child.stdin.end(input);
        }
    });
}
