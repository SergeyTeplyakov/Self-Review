import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Delivery, ReviewService, Store, runGit, startReviewServer } from "./modules.mjs";

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

    const service = new ReviewService({ store: new Store(path.join(tmp, "reviews")) });
    const review = await service.ensureReview({ repoPath: repo, base: "main", scope: "pending" });
    const { files } = await service.getSnapshot(review);
    for (const [name, status, bytes] of [["renamed.png", "renamed", png(1)], ["b.png", "modified", png(2)]] as const) {
        const file = files.find((entry) => entry.path === name);
        assert.ok(file, name);
        assert.equal(file.status, status);
        assert.equal(file.hunks.length, 0);
        for (const side of ["old", "new"]) {
            assert.deepEqual((await service.getDiffImage(review, "r1", name, side)).bytes, bytes, `${name} ${side}`);
        }
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
