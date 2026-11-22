import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Review } from "../src/lib/review-service.mjs";
import { host, registerTestHost } from "./provider-host.mjs";

// The extension stores data under the user's home directory; point it at a temporary one before loading anything.
const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "mr-extension-open-")));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

registerTestHost();

const { runGit, Store, defaultDataRoot, ReviewService, computeReviewId, loadExtension } = await import("./modules.mjs");
const git = (cwd: string, ...args: string[]) => runGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args]);

function required<T>(value: T | null | undefined): T {
    assert.ok(value);
    return value;
}

after(async () => {
    await rm(tmp, { recursive: true, force: true });
});

test("reopening a retired commit review without a usable origin keeps its path filters", async () => {
    const repo = path.join(tmp, "proj");
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await mkdir(path.join(repo, "src"));
    await mkdir(path.join(repo, "docs"));
    for (const file of ["src/keep.ts", "src/skip.ts", "docs/guide.md"]) await writeFile(path.join(repo, file), "base\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "base");
    await git(repo, "checkout", "-q", "-b", "feature");
    for (const file of ["src/keep.ts", "src/skip.ts", "docs/guide.md"]) await writeFile(path.join(repo, file), "changed\n");
    await git(repo, "commit", "-q", "-am", "feature work");

    // A historical single-commit review (with the old commit-style ID) that was limited to src/ minus src/skip.ts.
    const store = new Store(defaultDataRoot());
    const service = new ReviewService({ store });
    const filters = { paths: ["src"], exclude: ["src/skip.ts"] };
    const seedId = await service.ensureReview({ repoPath: repo, base: "main", ...filters });
    const seed = required(await store.readReview(seedId));
    const commit = required(seed.git).headCommit;
    const retiredId = `proj-commit-${commit.slice(0, 12)}-0123456789abcdef`;
    await store.updateReview(retiredId, () => ({
        review: { ...seed, reviewId: retiredId, scope: "commit", commit } as Review & { commit: string },
    }));
    await rm(path.dirname(store.reviewFile(seedId)), { recursive: true, force: true });
    const missingOrigin = computeReviewId({ repoRoot: repo, branch: "gone", base: "main" });
    await writeFile(path.join(defaultDataRoot(), "instances.json"), JSON.stringify({
        "no-origin": { reviewId: retiredId, returnReviewId: null },
        "gone-origin": { reviewId: retiredId, returnReviewId: missingOrigin },
    }));

    await loadExtension();
    const canvas = required(host.canvases[0]);
    try {
        for (const instanceId of ["no-origin", "gone-origin"]) {
            await canvas.open({ instanceId, input: {}, session: { workingDirectory: repo } });
            const reopenedId = required(await store.getInstanceContext(instanceId)).reviewId;
            assert.notEqual(reopenedId, retiredId, `${instanceId}: the retired review is not reopened`);
            const reopened = required(await store.readReview(reopenedId));
            assert.notEqual(reopened.scope, "commit");
            assert.deepEqual({ paths: reopened.paths, exclude: reopened.exclude }, filters, `${instanceId}: path filters are preserved`);
            const snapshot = required(await store.readSnapshot(reopenedId, reopened.currentRevisionId));
            assert.deepEqual(snapshot.files.map((f) => f.path), ["src/keep.ts"], `${instanceId}: the fallback review is not widened`);
        }
        assert.ok(host.logs.some(({ message, level }) => level === "warning" && message.includes("historical single-commit review")));
    } finally {
        for (const instanceId of ["no-origin", "gone-origin"]) await canvas.onClose?.({ instanceId });
    }
});
