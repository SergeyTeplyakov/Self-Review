import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Delivery, ReviewService, Store, SVG_PROLOG_BYTES, diffImageType, isSvg, readGitBlobPrefixes, runGit, startReviewServer } from "./modules.mjs";

test("image requests serve only the selected side, review and revision", async (t) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "image-diff-test-"));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const repo = path.join(tmp, "repo");
    await mkdir(repo);
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.invalid",
        "-c", "commit.gpgsign=false", ...args]);
    const png = (value: number) => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, value]);
    const image = "a & b.PNG";
    const put = (name: string, bytes: Buffer) => writeFile(path.join(repo, name), bytes);
    await git("init", "-q", "-b", "main");
    await put(image, png(1));
    await put("removed.png", png(4));
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("checkout", "-qb", "feature");
    await put(image, png(2));
    await git("commit", "-qam", "update image");
    await put(image, png(3));
    await rm(path.join(repo, "removed.png"));
    await put("added.png", png(5));
    await put("other.bin", png(6));
    await put("invalid.png", Buffer.from([0, 1]));
    await put("large.png", Buffer.concat([png(7), Buffer.alloc(2 * 1024 * 1024)]));
    await git("add", "invalid.png", "large.png");

    const service = new ReviewService({ store: new Store(path.join(tmp, "reviews")) });
    const all = await service.ensureReview({ repoPath: repo, base: "main", scope: "all" });
    const pending = await service.ensureReview({ repoPath: repo, base: "main", scope: "pending" });
    let active = all;
    const server = await startReviewServer({
        service, delivery: new Delivery({ service, send: async () => { throw new Error("Unexpected delivery"); } }),
        instanceId: "images", getReviewId: () => active,
        webRoot: fileURLToPath(new URL("../dist/web/", import.meta.url)),
    });
    try {
        const get = (name: string, side: string, { rev = "r1", review = active, auth = true } = {}) => {
            const url = new URL(server.url);
            url.pathname = `/api/diff-image/${rev}`;
            if (!auth) url.searchParams.delete("t");
            url.searchParams.set("review", review);
            url.searchParams.set("side", side);
            url.searchParams.set("path", name);
            return fetch(url);
        };
        const expectBytes = async (name: string, side: string, expected: Buffer, rev?: string) => {
            const res = await get(name, side, { rev });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get("Content-Type"), "image/png");
            assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
            assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected);
        };
        await expectBytes(image, "old", png(1));
        await expectBytes(image, "new", png(3));
        active = pending;
        await expectBytes(image, "old", png(2));
        await expectBytes("added.png", "new", png(5));
        await expectBytes("removed.png", "old", png(4));
        for (const [name, side] of [["added.png", "old"], ["removed.png", "new"], ["other.bin", "new"],
            ["invalid.png", "new"], ["large.png", "new"], ["missing.png", "new"]]) {
            assert.equal((await get(name, side)).status, 404, `${name} ${side}`);
        }
        assert.equal((await get(image, "new", { review: all })).status, 404);
        assert.equal((await get(image, "new", { auth: false })).status, 403);
        await put(image, png(8));
        await put("added.png", png(9));
        assert.equal((await get(image, "new")).status, 404, "never substitute newer working bytes");
        assert.equal((await get("added.png", "new")).status, 404);
        const { revisionId } = await service.refresh(active);
        assert.notEqual(revisionId, "r1");
        await expectBytes(image, "new", png(8), revisionId);
        await expectBytes("added.png", "new", png(9), revisionId);
    } finally {
        await server.close();
    }
});

test("pure image renames and mode-only changes preview the unchanged blob on both sides", async (t) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "image-diff-test-"));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const repo = path.join(tmp, "repo");
    await mkdir(repo);
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.invalid",
        "-c", "commit.gpgsign=false", ...args]);
    const png = (value: number) => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, value]);
    await git("init", "-q", "-b", "main");
    await writeFile(path.join(repo, "a.png"), png(1));
    await writeFile(path.join(repo, "b.png"), png(2));
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("mv", "a.png", "renamed.png");
    // Set both: Git reads the working-tree mode where core.filemode is on and the index mode where it is off.
    await chmod(path.join(repo, "b.png"), 0o755);
    await git("update-index", "--chmod=+x", "b.png");

    const store = new Store(path.join(tmp, "reviews"));
    const service = new ReviewService({ store });
    const review = await service.ensureReview({ repoPath: repo, base: "main", scope: "pending" });
    const expectPreviews = async (revisionId: string) => {
        const { files } = await service.getSnapshot(review);
        for (const [name, status, bytes] of [["renamed.png", "renamed", png(1)], ["b.png", "modified", png(2)]] as const) {
            const file = files.find((entry) => entry.path === name);
            assert.ok(file, name);
            assert.equal(file.status, status);
            assert.equal(file.hunks.length, 0);
            for (const side of ["old", "new"]) {
                assert.deepEqual((await service.getDiffImage(review, revisionId, name, side)).bytes, bytes, `${name} ${side}`);
            }
        }
    };
    await expectPreviews("r1");

    // A provider without image previews stored no image sides, and fingerprinted only the base commit and Git's diff,
    // which these changes leave exactly as it was. Refresh must still store a revision that previews them.
    const legacy = await store.readSnapshot(review, "r1");
    assert.ok(legacy);
    const diff = await git("diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/",
        "--dst-prefix=b/", "-U5", legacy.baseCommit, "--");
    const fingerprint = createHash("sha256").update(legacy.baseCommit).update("\0").update(diff.stdout).digest("hex");
    await store.writeSnapshot(review, "r1", { ...legacy, fingerprint, files: legacy.files.map(({ imageSides, ...file }) => file) });
    await store.updateReview(review, (current) => {
        assert.ok(current);
        current.revisions[0].fingerprint = fingerprint;
        return { review: current };
    });
    await assert.rejects(service.getDiffImage(review, "r1", "renamed.png", "new"));
    assert.equal((await service.refresh(review)).revisionId, "r2");
    await expectPreviews("r2");
});

test("a pure image rename from a path with a line break previews the unchanged blob", async (t) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "image-diff-test-"));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const repo = path.join(tmp, "repo");
    await mkdir(repo);
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.invalid",
        "-c", "commit.gpgsign=false", ...args]);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
    const oldPath = "line\nbreak.png";
    await git("init", "-q", "-b", "main");
    await writeFile(path.join(repo, "renamed.png"), png);
    // Windows cannot create such a file, so build the base commit from objects.
    const blob = (await git("hash-object", "-w", "renamed.png")).stdout.trim();
    const tree = (await runGit(repo, ["mktree", "-z"], { input: `100644 blob ${blob}\t${oldPath}\0` })).stdout.trim();
    await git("update-ref", "refs/heads/main", (await git("commit-tree", tree, "-m", "base")).stdout.trim());
    await git("add", "renamed.png");

    const service = new ReviewService({ store: new Store(path.join(tmp, "reviews")) });
    const review = await service.ensureReview({ repoPath: repo, base: "main", scope: "pending" });
    const file = (await service.getSnapshot(review)).files.find((entry) => entry.path === "renamed.png");
    assert.equal(file?.status, "renamed");
    assert.equal(file.oldPath, oldPath);
    for (const side of ["old", "new"]) {
        assert.deepEqual((await service.getDiffImage(review, "r1", "renamed.png", side)).bytes, png, side);
    }
});

// A valid 1x1 JPEG; jpeg() prefixes a comment so long that Git sees no NUL in the first 8000 bytes and diffs it as text.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDySiiivy8/vA//2Q==", "base64");
const jpeg = (label: string) => {
    const comment = Buffer.from(`${label} ${"x".repeat(8500)}`);
    const marker = Buffer.alloc(4);
    marker.writeUInt16BE(0xfffe, 0);
    marker.writeUInt16BE(comment.length + 2, 2);
    return Buffer.concat([JPEG.subarray(0, 2), marker, comment, JPEG.subarray(2)]);
};

test("images Git diffs as text preview from their bytes, while text named like an image keeps its diff", async (t) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "image-diff-test-"));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const repo = path.join(tmp, "repo");
    await mkdir(repo);
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.invalid",
        "-c", "commit.gpgsign=false", ...args]);
    const put = (name: string, bytes: Buffer | string) => writeFile(path.join(repo, name), bytes);
    const lfsPointer = (digit: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${String(digit).repeat(64)}\nsize ${digit}\n`;
    await git("init", "-q", "-b", "main");
    await put("photo.jpg", jpeg("v1"));
    await put("deleted.jpg", jpeg("gone"));
    await put("pointer.png", lfsPointer(1));
    await put("moved.png", lfsPointer(2));
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("checkout", "-qb", "feature");
    await put("photo.jpg", jpeg("v2"));
    await rm(path.join(repo, "deleted.jpg"));
    await put("pointer.png", lfsPointer(3));
    await git("mv", "moved.png", "pointer-moved.png");
    await git("commit", "-qam", "change files");
    const numstat = await git("diff", "--numstat", "main", "--", "photo.jpg");
    assert.match(numstat.stdout, /^\d+\t\d+\t/, "Git must diff the fixture as text");

    const service = new ReviewService({ store: new Store(path.join(tmp, "reviews")) });
    const fileIn = async (review: string, name: string, revision?: string) => {
        const file = (await service.getSnapshot(review, revision)).files.find((entry) => entry.path === name);
        assert.ok(file, name);
        return file;
    };
    const expectImage = async (review: string, revision: string, name: string, sides: { old?: Buffer; new?: Buffer }) => {
        const file = await fileIn(review, name, revision);
        assert.equal(file.binary, true, name);
        assert.equal(file.hunks.length, 0, name);
        assert.deepEqual(Object.keys(file.imageSides ?? {}).sort(), Object.keys(sides).sort(), name);
        for (const [side, bytes] of Object.entries(sides)) {
            assert.deepEqual((await service.getDiffImage(review, revision, name, side)).bytes, bytes, `${name} ${side}`);
        }
    };

    const all = await service.ensureReview({ repoPath: repo, base: "main", scope: "all" });
    await expectImage(all, "r1", "photo.jpg", { old: jpeg("v1"), new: jpeg("v2") });
    await expectImage(all, "r1", "deleted.jpg", { old: jpeg("gone") });
    const pointer = await fileIn(all, "pointer.png");
    assert.equal(pointer.binary, false);
    assert.ok(pointer.hunks.length, "an LFS pointer keeps its text diff");
    assert.equal(pointer.imageSides, undefined);
    const moved = await fileIn(all, "pointer-moved.png");
    assert.equal(moved.status, "renamed");
    assert.equal(moved.imageSides, undefined, "a renamed LFS pointer is not an image");

    await put("photo.jpg", jpeg("v3"));
    await put("new.jpg", jpeg("new"));
    const pending = await service.ensureReview({ repoPath: repo, base: "main", scope: "pending" });
    await expectImage(pending, "r1", "photo.jpg", { old: jpeg("v2"), new: jpeg("v3") });
    await expectImage(pending, "r1", "new.jpg", { new: jpeg("new") });
    // Staging must not turn the previewed image into a text diff.
    await git("add", "new.jpg");
    const { revisionId } = await service.refresh(pending);
    assert.notEqual(revisionId, "r1");
    assert.equal((await fileIn(pending, "new.jpg", revisionId)).untracked, false);
    await expectImage(pending, revisionId, "new.jpg", { new: jpeg("new") });
});

test("an image Git diffs as text that replaces a symlink previews beside the link's change", async (t) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "image-diff-test-"));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const repo = path.join(tmp, "repo");
    await mkdir(repo);
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.invalid",
        "-c", "commit.gpgsign=false", ...args]);
    await git("init", "-q", "-b", "main");
    // Recording the symlink in the index works even where the file system cannot create one.
    const target = (await runGit(repo, ["hash-object", "-w", "--stdin"], { input: "target.jpg" })).stdout.trim();
    await git("update-index", "--add", "--cacheinfo", `120000,${target},photo.jpg`);
    await git("commit", "-qm", "base");
    await git("rm", "-q", "--cached", "photo.jpg");
    await writeFile(path.join(repo, "photo.jpg"), jpeg("photo"));
    await git("add", "photo.jpg");
    assert.doesNotMatch((await git("diff", "--numstat", "HEAD", "--", "photo.jpg")).stdout, /^-\t-\t/m, "Git must diff the fixture as text");

    const service = new ReviewService({ store: new Store(path.join(tmp, "reviews")) });
    const review = await service.ensureReview({ repoPath: repo, base: "main", scope: "pending" });
    const file = (await service.getSnapshot(review)).files.find((entry) => entry.path === "photo.jpg");
    assert.ok(file);
    assert.equal(file.typeChanged, true);
    assert.equal(file.binary, true);
    assert.deepEqual(Object.keys(file.imageSides ?? {}), ["new"]);
    assert.deepEqual(file.hunks.flatMap((hunk) => hunk.rows).map((row) => [row.t, row.s]), [["del", "target.jpg"]], "the link's change stays");
    assert.deepEqual((await service.getDiffImage(review, "r1", "photo.jpg", "new")).bytes, jpeg("photo"));
});

test("SVG is recognized by its root element after any prolog, and only within the prolog limit", () => {
    const root = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    for (const text of [root, "<svg>", `\uFEFF \t${root}`,
        `<?xml version="1.0"?>\r\n<!-- a > b -->\n<!DOCTYPE svg [ <!ENTITY a "x>y"> ]>\n${root}`,
        `<!DOCTYPE svg [<!ENTITY marker "]">]>${root}`,
        `<!DOCTYPE svg [<!-- ] > " --><?pi ] > ' ?><!ENTITY a 'x"]>'>]>${root}`,
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${root}`]) {
        assert.equal(diffImageType(Buffer.from(text)), "svg", text);
    }
    for (const text of ["", "<svgx/>", "text <svg/>", "<html><svg/></html>", "<?xml", "<!-- unclosed <svg/>", "<!DOCTYPE svg [ <svg/>",
        `<!DOCTYPE svg [<!ENTITY a "]>"><svg/>`, `<!DOCTYPE svg SYSTEM "unclosed><svg/>`, `<!DOCTYPE svg [<!-- ]> <svg/>`,
        `<!--${"x".repeat(SVG_PROLOG_BYTES)}--><svg/>`]) {
        assert.equal(isSvg(Buffer.from(text)), false, text.slice(0, 40));
    }
    assert.equal(diffImageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1])), "png");
});

test("SVG changes keep their text diff beside sandboxed previews, and renamed images preview their old path", async (t) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "image-diff-test-"));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const repo = path.join(tmp, "repo");
    await mkdir(repo);
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.invalid",
        "-c", "commit.gpgsign=false", ...args]);
    const put = (name: string, bytes: Buffer | string) => writeFile(path.join(repo, name), bytes);
    // Unchanged lines keep a changed SVG similar enough for Git to detect its rename.
    const svg = (fill: string, eol = "\n") => Buffer.from([`<?xml version="1.0"?>`, `<!-- generated > by hand -->`,
        `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">`,
        ...Array.from({ length: 12 }, (_, i) => `<desc>unchanged line ${i}</desc>`),
        `<rect width="4" height="4" fill="${fill}"/>`, `</svg>`, ""].join(eol));
    const raster = (last: number) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(2000), Buffer.from([last])]);
    const lfsPointer = (digit: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${String(digit).repeat(64)}\nsize ${digit}\n`;
    await git("init", "-q", "-b", "main");
    await put(".gitattributes", "crlf.svg text eol=crlf\n");
    await put("icon.svg", svg("red"));
    await put("logo.svg", svg("green"));
    await put("pointer.svg", lfsPointer(1));
    await put("crlf.svg", svg("blue", "\r\n"));
    await put("photo.png", raster(1));
    await git("add", ".");
    await git("commit", "-qm", "base");
    await put("icon.svg", svg("orange"));
    await git("mv", "logo.svg", "brand.svg");
    await put("brand.svg", svg("lime"));
    await git("mv", "photo.png", "picture.png");
    await put("picture.png", raster(2));
    await git("add", "brand.svg", "picture.png");
    await put("pointer.svg", lfsPointer(2));
    await put("crlf.svg", svg("black", "\r\n"));
    await put("new.svg", svg("white"));

    const service = new ReviewService({ store: new Store(path.join(tmp, "reviews")) });
    const review = await service.ensureReview({ repoPath: repo, base: "main", scope: "pending" });
    const { files } = await service.getSnapshot(review);
    const fileNamed = (name: string) => {
        const file = files.find((entry) => entry.path === name);
        assert.ok(file, name);
        return file;
    };
    for (const name of ["icon.svg", "brand.svg", "crlf.svg", "new.svg"]) {
        const file = fileNamed(name);
        assert.equal(file.binary, false, name);
        assert.ok(file.hunks.length, `${name} keeps its text diff`);
        assert.deepEqual(Object.keys(file.imageSides ?? {}).sort(), name === "new.svg" ? ["new"] : ["new", "old"], name);
    }
    assert.equal(fileNamed("new.svg").untracked, true);
    for (const [name, oldPath] of [["brand.svg", "logo.svg"], ["picture.png", "photo.png"]]) {
        assert.equal(fileNamed(name).status, "renamed", `Git must detect the ${oldPath} rename`);
        assert.equal(fileNamed(name).oldPath, oldPath);
    }
    assert.equal(fileNamed("picture.png").binary, true);
    assert.equal(fileNamed("pointer.svg").imageSides, undefined, "an LFS pointer named like an SVG is not an image");

    const server = await startReviewServer({
        service, delivery: new Delivery({ service, send: async () => { throw new Error("Unexpected delivery"); } }),
        instanceId: "svg-images", getReviewId: () => review,
        webRoot: fileURLToPath(new URL("../dist/web/", import.meta.url)),
    });
    try {
        const expectImage = async (name: string, side: string, type: string, expected: Buffer) => {
            const url = new URL(server.url);
            url.pathname = "/api/diff-image/r1";
            url.searchParams.set("review", review);
            url.searchParams.set("side", side);
            url.searchParams.set("path", name);
            const res = await fetch(url);
            assert.equal(res.status, 200, `${name} ${side}`);
            assert.equal(res.headers.get("Content-Type"), type);
            assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'none'.*; sandbox$/);
            assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected, `${name} ${side}`);
        };
        await expectImage("icon.svg", "old", "image/svg+xml", svg("red"));
        await expectImage("icon.svg", "new", "image/svg+xml", svg("orange"));
        await expectImage("brand.svg", "old", "image/svg+xml", svg("green"));
        await expectImage("brand.svg", "new", "image/svg+xml", svg("lime"));
        // Git hashes this file after converting its line endings; serve the bytes on disk.
        await expectImage("crlf.svg", "new", "image/svg+xml", svg("black", "\r\n"));
        await expectImage("new.svg", "new", "image/svg+xml", svg("white"));
        await expectImage("picture.png", "old", "image/png", raster(1));
        await expectImage("picture.png", "new", "image/png", raster(2));
    } finally {
        await server.close();
    }
});

test("blob prefixes keep only the start of each wanted blob, across stream chunks", async (t) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "image-diff-test-"));
    t.after(() => rm(repo, { recursive: true, force: true }));
    await runGit(repo, ["init", "-q"]);
    const blob = async (name: string, bytes: Buffer) => {
        await writeFile(path.join(repo, name), bytes);
        return (await runGit(repo, ["hash-object", "-w", name])).stdout.trim();
    };
    // Larger than a pipe chunk, and full of newlines, so the next header arrives mid-chunk after content that looks like one.
    const large = await blob("large", Buffer.concat([Buffer.from("LARGE-START-"), Buffer.alloc(300 * 1024, "\n")]));
    const small = await blob("small", Buffer.from("tiny"));
    const tooLarge = await blob("too-large", Buffer.alloc(400 * 1024 + 1));
    const tree = (await runGit(repo, ["mktree"], { input: "" })).stdout.trim();
    const prefixes = await readGitBlobPrefixes(repo, [large, tooLarge, "1".repeat(large.length), tree, small, large], 400 * 1024, 12);
    assert.deepEqual(prefixes, new Map([[large, Buffer.from("LARGE-START-")], [small, Buffer.from("tiny")]]));
});
