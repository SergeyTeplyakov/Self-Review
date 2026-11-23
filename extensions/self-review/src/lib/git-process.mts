// Read-only Git process boundary shared by repository capture and settings identity.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBJECT_ENV = { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };

export async function readGitBlob(cwd: string, oid: string, maxBytes: number): Promise<Buffer | null> {
    if (!FULL_OID.test(oid)) throw new Error("Expected a full Git object ID.");
    try {
        const { stdout } = await promisify(execFile)("git", ["cat-file", "blob", oid], {
            cwd, encoding: "buffer", maxBuffer: maxBytes, windowsHide: true, env: { ...process.env, ...OBJECT_ENV },
        });
        return stdout;
    } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === 128 || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) return null;
        throw error;
    }
}

// Reads every listed blob that exists locally and fits in maxBytes with two Git processes, however many are listed.
// Failures leave blobs out, as if missing.
export async function readGitBlobs(cwd: string, oids: string[], maxBytes: number): Promise<Map<string, Buffer>> {
    const blobs = new Map<string, Buffer>();
    const listed = [...new Set(oids)];
    if (listed.some((oid) => !FULL_OID.test(oid))) throw new Error("Expected full Git object IDs.");
    if (!listed.length) return blobs;
    const check = await runGit(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        { allowFail: true, env: OBJECT_ENV, input: listed.map((oid) => `${oid}\n`).join("") });
    const sizes = new Map<string, number>();
    for (const line of check.stdout.split("\n")) {
        const [oid, type, size] = line.split(" ");
        if (type === "blob" && Number(size) <= maxBytes) sizes.set(oid, Number(size));
    }
    if (!sizes.size) return blobs;
    // --batch prints "<oid> blob <size>\n<bytes>\n" per object; 32 bytes covers everything but the ID and the bytes.
    let budget = 0;
    for (const [oid, size] of sizes) budget += oid.length + size + 32;
    const stdout = await new Promise<Buffer | null>((resolve) => {
        const child = execFile("git", ["cat-file", "--batch"], {
            cwd, encoding: "buffer", maxBuffer: budget, windowsHide: true, env: { ...process.env, ...OBJECT_ENV },
        }, (error, out) => resolve(error ? null : out));
        child.stdin?.on("error", () => resolve(null));
        child.stdin?.end([...sizes.keys()].map((oid) => `${oid}\n`).join(""));
    });
    for (let pos = 0; stdout && pos < stdout.length;) {
        const eol = stdout.indexOf(10, pos);
        if (eol < 0) break;
        const [oid, type, size] = stdout.toString("latin1", pos, eol).split(" ");
        pos = eol + 1;
        if (size === undefined) continue; // "<oid> missing" has no content.
        if (type === "blob") blobs.set(oid, stdout.subarray(pos, pos + Number(size)));
        pos += Number(size) + 1;
    }
    return blobs;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{allowFail?: boolean, input?: string}} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number | null}>}
 */
export function runGit(cwd: string, args: string[], { allowFail = false, input, env }: { allowFail?: boolean; input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{
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
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env },
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
