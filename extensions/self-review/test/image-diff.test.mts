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
