import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The extension stores data under the user's home directory; point it at a temporary one before loading anything.
const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "mr-extension-open-")));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

// Replace the Copilot SDK with an in-process fake so the real extension entry point can be driven directly.
const fake = { config: null, logs: [] };
globalThis.__selfReviewFakeSdk = fake;
const FAKE_SDK = `data:text/javascript,${encodeURIComponent(`
const fake = globalThis.__selfReviewFakeSdk;
export class CanvasError extends Error { constructor(code, message) { super(message); this.code = code; } }
export const createCanvas = (declaration) => declaration;
export async function joinSession(config) {
    fake.config = config;
    return { sessionId: "test-session", workspacePath: undefined, log: async (message, options) => { fake.logs.push({ message, level: options?.level }); }, send: async () => "message-1", on: () => () => {} };
}`)}`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@github/copilot-sdk/extension") return { url: FAKE_SDK, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const { runGit } = await import("../dist/lib/git.mjs");
const { Store, defaultDataRoot } = await import("../dist/lib/store.mjs");
const { ReviewService, computeReviewId } = await import("../dist/lib/review-service.mjs");
const git = (cwd, ...args) => runGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args]);

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
    const seed = await store.readReview(seedId);
    const commit = seed.git.headCommit;
    const retiredId = `proj-commit-${commit.slice(0, 12)}-0123456789abcdef`;
    await store.updateReview(retiredId, () => ({ review: { ...seed, reviewId: retiredId, scope: "commit", commit } }));
    await rm(path.dirname(store.reviewFile(seedId)), { recursive: true, force: true });
    const missingOrigin = computeReviewId({ repoRoot: repo, branch: "gone", base: "main" });
    await writeFile(path.join(defaultDataRoot(), "instances.json"), JSON.stringify({
        "no-origin": { reviewId: retiredId, returnReviewId: null },
        "gone-origin": { reviewId: retiredId, returnReviewId: missingOrigin },
    }));

    await import("../dist/extension.mjs");
    const canvas = fake.config.canvases[0];
    try {
        for (const instanceId of ["no-origin", "gone-origin"]) {
            await canvas.open({ instanceId, input: {}, session: { workingDirectory: repo } });
            const reopenedId = (await store.getInstanceContext(instanceId)).reviewId;
            assert.notEqual(reopenedId, retiredId, `${instanceId}: the retired review is not reopened`);
            const reopened = await store.readReview(reopenedId);
            assert.notEqual(reopened.scope, "commit");
            assert.deepEqual({ paths: reopened.paths, exclude: reopened.exclude }, filters, `${instanceId}: path filters are preserved`);
            const snapshot = await store.readSnapshot(reopenedId, reopened.currentRevisionId);
            assert.deepEqual(snapshot.files.map((f) => f.path), ["src/keep.ts"], `${instanceId}: the fallback review is not widened`);
        }
        assert.ok(fake.logs.some(({ message, level }) => level === "warning" && message.includes("historical single-commit review")));
    } finally {
        for (const instanceId of ["no-origin", "gone-origin"]) await canvas.onClose?.({ instanceId });
    }
});
