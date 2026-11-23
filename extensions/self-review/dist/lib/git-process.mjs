// Read-only Git process boundary shared by repository capture and settings identity.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBJECT_ENV = { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
export async function readGitBlob(cwd, oid, maxBytes) {
    if (!FULL_OID.test(oid))
        throw new Error("Expected a full Git object ID.");
    try {
        const { stdout } = await promisify(execFile)("git", ["cat-file", "blob", oid], {
            cwd, encoding: "buffer", maxBuffer: maxBytes, windowsHide: true, env: { ...process.env, ...OBJECT_ENV },
        });
        return stdout;
    }
    catch (error) {
        if (error instanceof Error && "code" in error && (error.code === 128 || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"))
            return null;
        throw error;
    }
}
// Reads the first prefixBytes of every listed blob that exists locally and fits in maxBytes, with two Git processes
// however many are listed. The blobs stream through and only their prefixes are kept, so memory stays bounded by
// prefixBytes per blob however large the blobs are. Failures leave blobs out, as if missing.
export async function readGitBlobPrefixes(cwd, oids, maxBytes, prefixBytes) {
    const prefixes = new Map();
    const listed = [...new Set(oids)];
    if (listed.some((oid) => !FULL_OID.test(oid)))
        throw new Error("Expected full Git object IDs.");
    if (!listed.length)
        return prefixes;
    // Sizes come first so that --batch never has to stream a blob too large to use.
    const check = await runGit(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { allowFail: true, env: OBJECT_ENV, input: listed.map((oid) => `${oid}\n`).join("") });
    const wanted = check.stdout.split("\n").map((line) => line.split(" "))
        .filter(([, type, size]) => type === "blob" && Number(size) <= maxBytes).map(([oid]) => oid);
    if (!wanted.length)
        return prefixes;
    await new Promise((resolve) => {
        const child = spawn("git", ["cat-file", "--batch"], {
            cwd, windowsHide: true, env: { ...process.env, ...OBJECT_ENV }, stdio: ["pipe", "pipe", "ignore"],
        });
        // --batch prints "<oid> <type> <size>\n<content>\n" per object, or "<oid> missing\n".
        let header = [];
        let object = null;
        child.stdout.on("data", (chunk) => {
            for (let pos = 0; pos < chunk.length;) {
                if (object) {
                    const take = Math.min(object.size + 1 - object.read, chunk.length - pos);
                    const keep = Math.min(take, Math.min(prefixBytes, object.size) - object.read);
                    // Copy, so a kept prefix does not pin the whole chunk.
                    if (keep > 0)
                        object.kept.push(Buffer.from(chunk.subarray(pos, pos + keep)));
                    object.read += take;
                    pos += take;
                    if (object.read === object.size + 1) {
                        if (object.blob)
                            prefixes.set(object.oid, Buffer.concat(object.kept));
                        object = null;
                    }
                    continue;
                }
                const eol = chunk.indexOf(10, pos);
                if (eol < 0) {
                    header.push(Buffer.from(chunk.subarray(pos)));
                    break;
                }
                const [oid, type, size] = Buffer.concat([...header, chunk.subarray(pos, eol)]).toString("latin1").split(" ");
                header = [];
                pos = eol + 1;
                if (size !== undefined)
                    object = { oid, blob: type === "blob", size: Number(size), read: 0, kept: [] };
            }
        });
        child.on("error", () => resolve());
        child.on("close", () => resolve());
        child.stdin.on("error", () => { });
        child.stdin.end(wanted.map((oid) => `${oid}\n`).join(""));
    });
    return prefixes;
}
/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{allowFail?: boolean, input?: string}} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number | null}>}
 */
export function runGit(cwd, args, { allowFail = false, input, env } = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile("git", ["--no-pager", "-c", "core.quotepath=false", ...args], {
            cwd,
            maxBuffer: 256 * 1024 * 1024,
            windowsHide: true,
            encoding: "utf8",
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env },
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
