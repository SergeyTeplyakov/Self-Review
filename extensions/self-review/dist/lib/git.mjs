// Read-only git access for capturing review snapshots. Never mutates the repository:
// GIT_OPTIONAL_LOCKS=0 keeps diff/status from rewriting the index.
import { readGitBlobPrefixes, runGit } from "./git-process.mjs";
export { runGit } from "./git-process.mjs";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { mergeTypeChanges, parseDiffPatches, synthesizeAddedFile } from "./diff.mjs";
import { DIFF_IMAGE_SNIFF_BYTES, diffImageType, imagePath, MAX_IMAGE_BYTES } from "./image-format.mjs";
const errorCode = (error) => error && typeof error === "object" && "code" in error ? error.code : undefined;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
export async function resolveRepoRoot(repoPath) {
    const { stdout } = await runGit(repoPath, ["rev-parse", "--show-toplevel"]);
    return path.resolve(stdout.trim());
}
export async function defaultBase(repoRoot) {
    const head = await runGit(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFail: true });
    if (head.ok && head.stdout.trim())
        return head.stdout.trim();
    for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
        const r = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", candidate], { allowFail: true });
        if (r.ok)
            return candidate;
    }
    throw new Error("Could not determine a base ref; pass input.base explicitly.");
}
export function buildPathspec(paths, exclude) {
    const spec = [];
    if (paths && paths.length)
        spec.push(...paths);
    else
        spec.push(".");
    for (const e of exclude ?? [])
        spec.push(`:(exclude)${e}`);
    return spec;
}
// Resolves a repo-relative path and refuses anything that escapes the repository.
export function safeJoin(repoRoot, relPath) {
    const full = path.resolve(repoRoot, relPath);
    const rel = path.relative(repoRoot, full);
    // Only a whole ".." component escapes; names such as "..notes" stay inside the repository.
    if (rel.split(/[\\/]/)[0] === ".." || path.isAbsolute(rel))
        throw new Error(`Path escapes repository: ${relPath}`);
    return full;
}
function isBinary(buffer) {
    const len = Math.min(buffer.length, 8000);
    for (let i = 0; i < len; i++)
        if (buffer[i] === 0)
            return true;
    return false;
}
async function readUntracked(repoRoot, relPath) {
    const result = await readRepoFile(repoRoot, relPath, MAX_UNTRACKED_BYTES);
    if (!result)
        return null;
    if (result.tooLarge) {
        return { path: relPath, oldPath: null, status: "added", binary: true, untracked: true, additions: 0, deletions: 0, hunks: [], contentHash: result.contentHash, note: "File too large to display" };
    }
    const { buffer } = result;
    const image = imagePath(relPath) ? diffImageType(buffer) : undefined;
    const imageSides = image && { imageSides: { new: result.contentHash } };
    if ((image && image !== "svg") || isBinary(buffer)) {
        return { path: relPath, oldPath: null, status: "added", binary: true, untracked: true, additions: 0, deletions: 0, hunks: [], contentHash: result.contentHash,
            ...imageSides };
    }
    // SVG is text: it keeps its diff beside the preview.
    return { ...synthesizeAddedFile(relPath, buffer.toString("utf8")), contentHash: result.contentHash, ...imageSides };
}
// Read symlinks as Git does (their target text), never as the target's contents.
// Resolve and check the parent too, so junctions/directory symlinks cannot escape.
async function readRepoFile(repoRoot, relPath, maxBytes = Infinity, hashOversized = true) {
    const full = safeJoin(repoRoot, relPath);
    const root = await realpath(repoRoot);
    const parent = await realpath(path.dirname(full));
    const checked = safeJoin(root, path.relative(root, path.join(parent, path.basename(full))));
    const info = await lstat(checked);
    if (info.isSymbolicLink()) {
        const buffer = Buffer.from(await readlink(checked));
        return { buffer, contentHash: createHash("sha256").update(buffer).digest("hex") };
    }
    if (!info.isFile())
        return null;
    const resolved = await realpath(checked);
    safeJoin(root, path.relative(root, resolved));
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        if (!hashOversized && (await handle.stat()).size > maxBytes)
            return null;
        if (!Number.isFinite(maxBytes))
            return { buffer: await handle.readFile() };
        const hash = createHash("sha256");
        const chunks = [];
        let size = 0;
        // Hash every byte from the same safe handle; retain only display-sized files in memory.
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            hash.update(chunk);
            size += chunk.length;
            if (!hashOversized && size > maxBytes)
                return null;
            if (size <= maxBytes)
                chunks.push(chunk);
            else
                chunks.length = 0;
        }
        const contentHash = hash.digest("hex");
        return size > maxBytes ? { tooLarge: true, contentHash } : { buffer: Buffer.concat(chunks), contentHash };
    }
    finally {
        await handle.close();
    }
}
// A symlink's blob holds its target path and a submodule's ID names a commit; only regular files hold their content.
function regularFile(mode) {
    return mode === undefined || mode.startsWith("100");
}
// Git reports image sides only for files it diffs as binary. Find the rest, keeping only sides whose exact bytes have
// an image signature or an <svg> root, so text with an image name, such as a Git LFS pointer, keeps its text diff:
// - Git diffs a file as text when its first 8000 bytes contain no NUL, which some valid JPEGs and every SVG satisfy.
// - Git omits the index line only when content is unchanged (a pure rename or mode change), so both sides are the base blob.
// Pass patches before mergeTypeChanges, so that a symlink replaced by an image checks the image alone.
async function addImageSides(repoRoot, baseCommit, patches, textImageIds) {
    const candidates = [];
    const unchanged = [];
    for (const file of patches) {
        if (file.imageSides || file.binary || !(imagePath(file.path) || imagePath(file.oldPath)))
            continue;
        const ids = textImageIds.get(file);
        if (ids) {
            const sides = {};
            if (file.status !== "added" && regularFile(file.oldMode))
                sides.old = ids[0];
            if (file.status !== "deleted" && regularFile(file.newMode))
                sides.new = ids[1];
            candidates.push({ file, sides });
        }
        else if (!file.hunks.length && (file.status === "modified" || file.status === "renamed")
            && regularFile(file.oldMode) && regularFile(file.newMode)) {
            unchanged.push(file);
        }
    }
    if (unchanged.length) {
        // cat-file reads one object name per line, so resolve a path containing a line break on its own.
        const names = await Promise.all(unchanged.map(async (file) => {
            const name = `${baseCommit}:${file.oldPath ?? file.path}`;
            if (!/[\r\n]/.test(name))
                return name;
            const resolved = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", name], { allowFail: true, env: { GIT_NO_LAZY_FETCH: "1" } });
            return resolved.ok ? resolved.stdout.trim() : null;
        }));
        const lookups = unchanged.flatMap((file, i) => names[i] ? [{ file, name: names[i] }] : []);
        const lookup = await runGit(repoRoot, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
            allowFail: true, env: { GIT_NO_LAZY_FETCH: "1" },
            input: lookups.map(({ name }) => `${name}\n`).join(""),
        });
        const lines = lookup.ok ? lookup.stdout.split("\n") : [];
        lookups.forEach(({ file }, i) => {
            const blob = /^([0-9a-f]{40}|[0-9a-f]{64}) blob$/.exec(lines[i] ?? "");
            if (blob)
                candidates.push({ file, sides: { old: blob[1], new: blob[1] } });
        });
    }
    if (!candidates.length)
        return;
    // One stream for every candidate, since where images live in Git LFS every changed image is a text candidate.
    // Only signatures are kept, so memory does not grow with the candidates' total size.
    const signatures = await readGitBlobPrefixes(repoRoot, candidates.flatMap(({ sides }) => [sides.old, sides.new].filter((oid) => oid !== undefined)), MAX_IMAGE_BYTES, DIFF_IMAGE_SNIFF_BYTES);
    for (const { file, sides } of candidates) {
        const images = {};
        let raster = false;
        for (const side of ["old", "new"]) {
            const oid = sides[side];
            if (!oid)
                continue;
            // Git's diff names an unstaged file's blob without storing it; use the file only if its bytes still match.
            const bytes = signatures.get(oid) ?? (side === "new" ? await readMatchingWorkingImage(repoRoot, file, oid) : null);
            const type = bytes && diffImageType(bytes);
            if (!type)
                continue;
            images[side] = oid;
            raster ||= type !== "svg";
        }
        if (!images.old && !images.new)
            continue;
        file.imageSides = images;
        // As Git does, show the whole change as binary when either side is. SVG is text and keeps its diff.
        if (raster && textImageIds.has(file))
            Object.assign(file, { binary: true, hunks: [], additions: 0, deletions: 0 });
    }
}
// Refresh stores a new revision only when the fingerprint changes. Bump this when capture records data that Git's diff
// output does not show, so the next refresh of an existing review stores that data rather than keeping the revision
// captured without it. Version 2 added image sides, which a pure rename or mode change gains with an unchanged diff.
// Version 3 added SVG image sides.
const CAPTURE_VERSION = 3;
// scope "all" diffs the working tree against the merge-base with `base` (the whole branch or PR);
// scope "pending" diffs it against HEAD, so committed work is left out.
export async function captureSnapshot({ repoRoot, base, paths, exclude, includeUntracked = true, contextLines = 5, scope = "all" }) {
    const head = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const branch = (await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    let baseCommit = head;
    if (scope !== "pending") {
        const mergeBase = await runGit(repoRoot, ["merge-base", base, "HEAD"], { allowFail: true });
        baseCommit = mergeBase.ok && mergeBase.stdout.trim()
            ? mergeBase.stdout.trim()
            : (await runGit(repoRoot, ["rev-parse", "--verify", base])).stdout.trim();
    }
    const pathspec = buildPathspec(paths, exclude);
    // Explicit prefixes keep the a/ and b/ headers the parser expects, whatever diff.noprefix or diff.mnemonicPrefix say.
    // --no-textconv keeps hunks in the file's real content, which anchors and agent edits use.
    const diff = await runGit(repoRoot, [
        "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--full-index", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", `-U${contextLines}`, baseCommit, "--", ...pathspec,
    ]);
    const textImageIds = new Map();
    const patches = parseDiffPatches(diff.stdout, textImageIds);
    await addImageSides(repoRoot, baseCommit, patches, textImageIds);
    const files = mergeTypeChanges(patches);
    const hash = createHash("sha256").update(`capture v${CAPTURE_VERSION}\0`).update(baseCommit).update("\0").update(diff.stdout);
    if (includeUntracked) {
        const list = await runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec]);
        const untracked = list.stdout.split("\0").filter(Boolean).sort();
        for (const rel of untracked) {
            const entry = await readUntracked(repoRoot, rel).catch((err) => {
                if (errorCode(err) === "ENOENT")
                    return null;
                throw err;
            });
            if (!entry)
                continue;
            files.push(entry);
            // The whole entry, not only its hunks: an empty, binary, or oversized file all have no hunks.
            hash.update("\0untracked\0").update(rel).update("\0").update(JSON.stringify(entry));
        }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const status = await runGit(repoRoot, ["status", "--porcelain=v1", "-z",
        `--untracked-files=${includeUntracked ? "all" : "no"}`, "--", ...pathspec]);
    const pending = status.stdout.split("\0");
    // Status can report an unstaged modification for a stale index stat entry
    // even when Git's content-aware diff is empty. Do not refresh the user's index.
    const uncommittedFiles = [];
    const checkContent = [];
    for (let i = 0; i < pending.length; i++) {
        const entry = pending[i];
        if (!entry)
            continue;
        const [index, worktree] = entry;
        const file = entry.slice(3);
        if (index === " " && worktree === "M")
            checkContent.push(file);
        else
            uncommittedFiles.push(file);
        if (/[RC]/.test(entry.slice(0, 2)))
            i++; // NUL porcelain includes the original path as an extra field.
    }
    if (checkContent.length) {
        const diffPaths = baseCommit === head
            ? new Set(files.map((file) => file.path))
            : new Set((await runGit(repoRoot, [
                "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", head, "--", ...pathspec,
            ])).stdout.split("\0"));
        const gitlinks = new Set();
        if (checkContent.some((file) => !diffPaths.has(file))) {
            // Porcelain can report a dirty submodule even when diff has no patch
            // for it. Preserve Git's status decision for gitlinks.
            const index = await runGit(repoRoot, ["ls-files", "--stage", "-z", "--", ...pathspec]);
            for (const entry of index.stdout.split("\0")) {
                if (entry.startsWith("160000 "))
                    gitlinks.add(entry.slice(entry.indexOf("\t") + 1));
            }
        }
        uncommittedFiles.push(...checkContent.filter((file) => diffPaths.has(file) || gitlinks.has(file)));
    }
    let upstream = null;
    const up = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true });
    if (up.ok && up.stdout.trim()) {
        const counts = await runGit(repoRoot, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], { allowFail: true });
        const [behind = null, ahead = null] = counts.ok ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
        upstream = { name: up.stdout.trim(), ahead, behind };
    }
    return {
        base,
        baseCommit,
        headCommit: head,
        branch,
        upstream,
        uncommittedFiles,
        fingerprint: hash.digest("hex"),
        files,
    };
}
export async function readWorkingFile(repoRoot, relPath) {
    try {
        const result = await readRepoFile(repoRoot, relPath);
        return result && !result.tooLarge ? result.buffer.toString("utf8").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)) : null;
    }
    catch (err) {
        if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR")
            return null;
        throw err;
    }
}
export async function readCommitFile(repoRoot, commit, relPath) {
    const r = await runGit(repoRoot, ["show", `${commit}:${relPath}`], { allowFail: true });
    if (!r.ok)
        return null;
    return r.stdout.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}
export async function readMatchingWorkingImage(repoRoot, file, expected) {
    try {
        const result = await readRepoFile(repoRoot, file.path, MAX_IMAGE_BYTES, false);
        if (!result || result.tooLarge)
            return null;
        const bytes = result.buffer;
        if (file.untracked)
            return result.contentHash === expected ? bytes : null;
        const blobId = (content) => createHash(expected.length === 64 ? "sha256" : "sha1")
            .update(`blob ${content.length}\0`).update(content).digest("hex");
        if (blobId(bytes) === expected)
            return bytes;
        // Git hashes text after converting CRLF to LF on check-in (core.autocrlf, text, eol). XML parsers read CRLF as
        // LF, so an SVG that matches once converted renders exactly as its blob does.
        const normalized = diffImageType(bytes) === "svg" && Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
        return normalized && blobId(normalized) === expected ? bytes : null;
    }
    catch (err) {
        if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR")
            return null;
        throw err;
    }
}
