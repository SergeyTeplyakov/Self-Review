import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as realDelay } from "node:timers/promises";
import { captureSnapshot, Delivery, ReviewService, ReviewWatcher, Store, runGit, startReviewServer } from "./modules.mjs";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error("Automatic refresh did not arrive.");
        await delay(25);
    }
}

async function fixture(t: TestContext) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "sr-watch-"));
    const repo = path.join(tmp, "repo");
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args]);
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await writeFile(path.join(repo, "file.ts"), "base\n");
    await writeFile(path.join(repo, ".gitignore"), "node_modules/\nbuild/\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const store = new Store(path.join(tmp, "data"));
    const service = new ReviewService({ store });
    const id = await service.ensureReview({ repoPath: repo, scope: "pending", exclude: ["excluded.ts"] });
    let refreshes = 0;
    const logs: string[] = [];
    const watcher = new ReviewWatcher({
        getReview: (id) => service.getReview(id),
        refresh: async (id, current) => { refreshes++; return service.refresh(id, current); },
    }, (text) => logs.push(text), 100);
    t.after(async () => { await watcher.close(); await rm(tmp, { recursive: true, force: true }); });
    return { tmp, repo, git, store, service, id, watcher, logs, count: () => refreshes };
}

test("pending and all match Git's inventory and patch without counting CRLF index stat mismatches", async (t) => {
    const f = await fixture(t);
    const git = (...args: string[]) => f.git("-c", "core.autocrlf=true", ...args);
    const generated = path.join(f.repo, "generated.txt");
    const dist = "extensions/self-review/dist";
    const testFile = "extensions/self-review/test/handwritten.test.mts";
    await mkdir(path.join(f.repo, dist), { recursive: true });
    await mkdir(path.dirname(path.join(f.repo, testFile)), { recursive: true });
    await writeFile(path.join(f.repo, dist, "artifact.js"), "old output\n");
    await writeFile(path.join(f.repo, testFile), "old test\n");
    await writeFile(generated, "one\r\ntwo\r\n");
    await git("add", ".");
    await git("commit", "-qm", "add CRLF worktree file");
    await git("switch", "-qc", "feature");
    await writeFile(path.join(f.repo, ".gitattributes"), "generated.txt text eol=lf\n");
    await git("add", ".gitattributes");
    await git("commit", "-qm", "canonical line endings");
    await writeFile(generated, "one\ntwo\n");
    assert.match((await git("status", "--porcelain")).stdout, /^ M generated\.txt\r?$/m);
    await writeFile(path.join(f.repo, "file.ts"), "edited\n");
    await writeFile(path.join(f.repo, testFile), "new test\n");
    await writeFile(path.join(f.repo, dist, "artifact.js"), "new output\n");
    await writeFile(path.join(f.repo, "staged.ts"), "staged\n");
    await git("add", "staged.ts");
    await writeFile(path.join(f.repo, "new.ts"), "untracked\n");
    const gitPaths = ["--", ".", `:(exclude)${dist}`];
    const mergeBase = (await git("merge-base", "main", "HEAD")).stdout.trim();
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    assert.notEqual(mergeBase, head);
    const indexPath = path.join(f.repo, ".git", "index");
    const indexBefore = await readFile(indexPath);
    for (const scope of ["pending", "all"] as const) {
        const base = scope === "all" ? mergeBase : head;
        const snapshot = await captureSnapshot({ repoRoot: f.repo, base: "main", scope, exclude: [dist] });
        assert.equal(snapshot.baseCommit, base);
        const tracked = (await git("diff", "--name-status", base, ...gitPaths)).stdout.trim().split(/\r?\n/);
        const untracked = (await git("ls-files", "--others", "--exclude-standard", ...gitPaths)).stdout.trim().split(/\r?\n/);
        const statusLetter: Record<string, string> = { modified: "M", added: "A", deleted: "D" };
        assert.deepEqual(snapshot.files.map((file) => `${statusLetter[file.status]}\t${file.path}`).sort(),
            [...tracked, ...untracked.map((file) => `A\t${file}`)].sort());
        assert.deepEqual(snapshot.uncommittedFiles.sort(), [testFile, "file.ts", "new.ts", "staged.ts"]);
        assert.ok(snapshot.files.some((file) => file.path === testFile), "the dist exclusion keeps handwritten tests");
        assert.equal(snapshot.files.some((file) => file.path === ".gitattributes"), scope === "all");
        for (const file of snapshot.files.filter((file) => !file.untracked)) {
            const gitPatch = (await git("diff", "--no-color", base, "--", file.path)).stdout.split(/\r?\n/);
            const gitEdits = gitPatch.slice(gitPatch.findIndex((line) => line.startsWith("@@")) + 1)
                .filter((line) => line.startsWith("+") || line.startsWith("-"));
            const snapshotEdits = file.hunks.flatMap((hunk) => hunk.rows.flatMap((row) =>
                row.t === "ctx" ? [] : [(row.t === "add" ? "+" : "-") + row.s]));
            assert.deepEqual(snapshotEdits, gitEdits, `${scope}: ${file.path}`);
        }
    }
    assert.deepEqual(await readFile(indexPath), indexBefore, "review captures never rewrite the index");
    await writeFile(generated, "one\nchanged\n");
    const changed = await captureSnapshot({ repoRoot: f.repo, base: null, scope: "pending", exclude: [dist] });
    assert.deepEqual(changed.uncommittedFiles.sort(), [testFile, "file.ts", "generated.txt", "new.ts", "staged.ts"]);
});

test("debounce waits for the last event and releases every watcher and pending timer on close", async (t) => {
    const f = await fixture(t);
    const sources = new Map<string, { change: (file: string | null) => void; fail: (error: Error) => void; closed: boolean }>();
    let calls = 0;
    let notify = () => {};
    const watcher = new ReviewWatcher({
        getReview: (id) => f.service.getReview(id),
        refresh: async () => { calls++; notify(); return { revisionId: "r1", created: false, moved: 0 }; },
    }, (text) => f.logs.push(text), 100, (root, change, fail) => {
        const source = { change, fail, closed: false };
        sources.set(root, source);
        return { close: () => { source.closed = true; } };
    });
    t.after(() => watcher.close());
    await watcher.setReview(f.id);
    const source = sources.get(f.repo);
    assert.ok(source);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    source.change("file.ts");
    t.mock.timers.tick(99);
    source.change("file.ts");
    t.mock.timers.tick(99);
    assert.equal(calls, 1, "no refresh before the quiet interval");
    const refreshed = new Promise<void>((resolve) => { notify = resolve; });
    t.mock.timers.tick(1);
    await refreshed;
    assert.equal(calls, 2, "the burst produces exactly one refresh");
    await writeFile(path.join(f.repo, "file.ts"), "changed during continuous watcher noise\n");
    const settledRefresh = new Promise<void>((resolve) => { notify = resolve; });
    source.change("file.ts");
    for (let i = 0; i < 20; i++) {
        t.mock.timers.tick(99);
        source.change("file.ts");
    }
    assert.equal(calls, 2, "even a long burst cannot force a refresh before it settles");
    t.mock.timers.tick(100);
    await settledRefresh;
    assert.equal(calls, 3);
    source.fail(new Error("watch failed"));
    assert.ok(source.closed);
    assert.match(f.logs[0] ?? "", /watch failed.*Manual Refresh remains available/);
    source.change("file.ts");
    await watcher.close();
    t.mock.timers.tick(500);
    assert.equal(calls, 3, "close cancels the queued refresh");
    assert.ok([...sources.values()].every((entry) => entry.closed));
});

test("ignored writes do not delay publication of a settled tracked edit", async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.repo, "build"));
    let change: (file: string) => void = () => assert.fail("checkout watcher not registered");
    const published: number[] = [];
    const checks: string[] = [];
    const watcher = new ReviewWatcher({
        getReview: (id) => f.service.getReview(id),
        refresh: async (id, current) => {
            // Even an ignored event delivered during capture must not invalidate it.
            if (published.length) change("build/noise.log");
            const result = await f.service.refresh(id, current);
            if (result) published.push((await f.service.getReview(id)).git!.uncommittedFiles);
        },
    }, (text) => f.logs.push(text), 100, (root, callback) => {
        if (root === f.repo) change = callback;
        return { close() {} };
    }, (root, args, options) => {
        checks.push(options?.input ?? "");
        return runGit(root, args, options);
    });
    t.after(() => watcher.close());
    await watcher.setReview(f.id);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await writeFile(path.join(f.repo, "file.ts"), "tracked edit\n");
    change("file.ts");
    for (let i = 0; i < 10; i++) {
        await appendFile(path.join(f.repo, "build", "noise.log"), "ignored write\n");
        change("build/noise.log");
        change("build/other.log");
        t.mock.timers.tick(20);
    }
    // Let Git finish without advancing the mocked clock past the last noise event.
    const deadline = Date.now() + 5000;
    while (published.length < 2 && Date.now() < deadline) await realDelay(25);
    assert.deepEqual(published, [0, 1]);
    assert.deepEqual(checks, ["build/noise.log\0build/other.log\0"], "ignored events share one async Git check");
});

test("a cancelled refresh retries when ignored-event classification finishes during cleanup", async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.repo, "build"));
    let change: (file: string) => void = () => assert.fail("checkout watcher not registered");
    let calls = 0;
    const watcher = new ReviewWatcher({
        getReview: (id) => f.service.getReview(id),
        refresh: async (id, current) => {
            if (++calls === 2) {
                change("build/noise.log");
                assert.equal(current(), false, "pending classification cancels publication");
                await until(current);
                return null;
            }
            return f.service.refresh(id, current);
        },
    }, (text) => f.logs.push(text), 50, (root, callback) => {
        if (root === f.repo) change = callback;
        return { close() {} };
    });
    t.after(() => watcher.close());
    await watcher.setReview(f.id);
    await writeFile(path.join(f.repo, "file.ts"), "settled edit\n");
    change("file.ts");
    await until(async () => (await f.service.getReview(f.id)).git?.uncommittedFiles === 1);
    assert.equal(calls, 3);
    assert.deepEqual(f.logs, []);
});

test("tracked output excluded from the review does not delay a source refresh", async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.repo, "dist"));
    const artifact = path.join(f.repo, "dist", "build.js");
    await writeFile(artifact, "original output\n");
    await f.git("add", "dist");
    await f.git("commit", "-qm", "track output");
    const id = await f.service.ensureReview({ repoPath: f.repo, scope: "pending", exclude: ["dist"] });
    let change: (file: string) => void = () => assert.fail("checkout watcher not registered");
    const watcher = new ReviewWatcher({
        getReview: (id) => f.service.getReview(id),
        refresh: (id, current) => f.service.refresh(id, current),
    }, (text) => f.logs.push(text), 100, (root, callback) => {
        if (root === f.repo) change = callback;
        return { close() {} };
    });
    t.after(() => watcher.close());
    await watcher.setReview(id);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await writeFile(path.join(f.repo, "file.ts"), "source edit\n");
    change("file.ts");
    for (let i = 0; i < 10; i++) {
        await appendFile(artifact, "generated output\n");
        change("dist/build.js");
        t.mock.timers.tick(20);
    }
    const deadline = Date.now() + 5000;
    while ((await f.service.getReview(id)).git?.uncommittedFiles === 0 && Date.now() < deadline) await realDelay(25);
    assert.deepEqual((await f.service.getSnapshot(id)).files.map((file) => file.path), ["file.ts"]);
});

test("a settled watcher refresh survives rejection of the preceding manual capture", async (t) => {
    const f = await fixture(t);
    await writeFile(path.join(f.repo, "file.ts"), "settled edit\n");
    let reject!: (error: Error) => void;
    const promise = new Promise<never>((_resolve, fail) => { reject = fail; });
    t.mock.method(f.service, "refreshOnce", () => promise);
    const manual = f.service.refresh(f.id);
    const rejected = assert.rejects(manual, /capture failed/);
    const queued = f.service.refresh(f.id, () => true);
    reject(new Error("capture failed"));
    await rejected;
    assert.equal((await queued)?.revisionId, "r2");
    assert.equal((await f.service.getReview(f.id)).git?.uncommittedFiles, 1);
});

for (const phase of ["snapshot", "metadata"] as const) {
    test(`invalidation during ${phase} persistence preserves the visible revision`, async (t) => {
        const f = await fixture(t);
        const before = await f.service.getReview(f.id);
        await writeFile(path.join(f.repo, "file.ts"), "transient contents\n");
        let current = true;
        const writer = phase === "snapshot" ? (() => {
            const writeSnapshot = f.store.writeSnapshot.bind(f.store);
            return t.mock.method(f.store, "writeSnapshot", async (...args: Parameters<typeof writeSnapshot>) => {
                await writeSnapshot(...args);
                current = false;
            });
        })() : undefined;
        const metadata = f.store.reviewFile(f.id);
        const result = await f.service.refresh(f.id, () => {
            if (phase === "metadata" && readdirSync(path.dirname(metadata)).some((name) =>
                name.startsWith(`${path.basename(metadata)}.`) && name.endsWith(".tmp"))) current = false;
            return current;
        });
        assert.equal(result, null);
        assert.equal(current, false, "the capture was invalidated at the intended persistence boundary");
        assert.deepEqual(await f.service.getReview(f.id), before);
        assert.equal(await f.store.readSnapshot(f.id, "r2"), null);
        assert.equal(readdirSync(path.dirname(metadata)).some((name) => name.endsWith(".tmp")), false);
        writer?.mock.restore();
        await writeFile(path.join(f.repo, "file.ts"), "settled contents\n");
        const settled = await f.service.refresh(f.id, () => true);
        assert.equal(settled?.revisionId, "r2", "the cancelled revision was not published");
    });
}

test("repeated dist rebuilds never publish transient uncommitted counts", async (t) => {
    const f = await fixture(t);
    const file = path.join(f.repo, "file.ts");
    const dist = path.join(f.repo, "dist");
    const output = Array.from({ length: 15 }, (_, i) => path.join(dist, `output-${i}.js`));
    const restoreDist = async () => {
        await mkdir(dist, { recursive: true });
        await Promise.all(output.map((name) => writeFile(name, "generated\n")));
    };
    await restoreDist();
    await f.git("add", "dist");
    await f.git("commit", "-qm", "track generated output");
    await writeFile(file, "initial local edit\n");
    await writeFile(path.join(f.repo, "other.ts"), "second local edit\n");
    await f.service.refresh(f.id);

    let checkout: ((file: string) => void) | undefined;
    let rebuild = 0;
    const capturedCounts: number[] = [];
    const service = new ReviewService({
        store: f.service.store,
        git: {
            ...f.service.git,
            captureSnapshot: async (options) => {
                const snapshot = await f.service.git.captureSnapshot(options);
                capturedCounts.push(snapshot.uncommittedFiles.length);
                if (snapshot.files.some((entry) => entry.path.startsWith("dist/") && entry.status === "deleted")) {
                    // Finish the destructive rebuild while the real Git snapshot is in flight.
                    await restoreDist();
                    await writeFile(file, `local edit after rebuild ${rebuild}\n`);
                    checkout?.("dist");
                }
                return snapshot;
            },
        },
    });
    let lastRevision = (await service.getReview(f.id)).currentRevisionId;
    const publishedCounts = [2];
    let finishedRebuilds = 0;
    const watcher = new ReviewWatcher({
        getReview: (id) => service.getReview(id),
        refresh: async (id, current) => {
            const result = await service.refresh(id, current);
            const review = await service.getReview(id);
            if (review.currentRevisionId !== lastRevision) {
                lastRevision = review.currentRevisionId;
                publishedCounts.push(review.git!.uncommittedFiles);
                if (!(await service.getSnapshot(id)).files.some((entry) => entry.path.startsWith("dist/"))) {
                    finishedRebuilds++;
                }
            }
            return result;
        },
    }, (text) => f.logs.push(text), 10, (root, change) => {
        if (root === f.repo) checkout = change;
        return { close() {} };
    });
    t.after(() => watcher.close());
    await watcher.setReview(f.id);
    assert.ok(checkout);
    for (rebuild = 1; rebuild <= 2; rebuild++) {
        await rm(dist, { recursive: true });
        checkout("dist");
        await until(() => finishedRebuilds === rebuild);
    }
    t.diagnostic(`Uncommitted counts: captured ${capturedCounts.join(" -> ")}; published ${publishedCounts.join(" -> ")}`);
    assert.deepEqual(capturedCounts, [2, 17, 2, 17, 2], "Git sees the real deletion during each rebuild");
    assert.deepEqual(publishedCounts, [2, 2, 2], "only settled snapshots reach the canvas count");
    assert.deepEqual(f.logs, []);
});

test("checkout edits preserve review options and ignore output and Git noise", async (t) => {
    const f = await fixture(t);
    await f.watcher.setReview(f.id);
    for (let i = 0; i < 5; i++) await writeFile(path.join(f.repo, "file.ts"), `changed ${i}\n`);
    await until(async () => (await f.service.getReview(f.id)).currentRevisionId === "r2");
    await delay(400);
    const review = await f.service.getReview(f.id);
    assert.equal(review.currentRevisionId, "r2");
    assert.equal(review.scope, "pending");
    assert.deepEqual(review.exclude, ["excluded.ts"]);
    assert.equal(review.base, null);
    await mkdir(path.join(f.repo, "node_modules"), { recursive: true });
    await writeFile(path.join(f.repo, "node_modules", "output.js"), "ignored\n");
    await writeFile(path.join(f.repo, ".git", "index.lock"), "noise\n");
    await delay(500);
    assert.equal((await f.service.getReview(f.id)).currentRevisionId, "r2", "ignored output and lock files do not create a revision");
    await mkdir(path.join(f.repo, "nested"));
    await writeFile(path.join(f.repo, "nested", "new.ts"), "new\n");
    await until(async () => (await f.service.getSnapshot(f.id)).files.some((file) => file.path === "nested/new.ts"));
    await rm(path.join(f.repo, "nested", "new.ts"));
    await until(async () => !(await f.service.getSnapshot(f.id)).files.some((file) => file.path === "nested/new.ts"));
    assert.deepEqual(f.logs, []);
});

test("unnamed events always refresh and directory replacement does not discard a debounce batch", async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.repo, "dir"));
    await writeFile(path.join(f.repo, "dir", "file.ts"), "tracked\n");
    await f.git("add", "dir");
    const sources = new Map<string, (file: string | null) => void>();
    let calls = 0;
    const watcher = new ReviewWatcher({
        getReview: (id) => f.service.getReview(id),
        refresh: async () => { calls++; return { revisionId: "r1", created: false, moved: 0 }; },
    }, (text) => f.logs.push(text), 10, (root, change) => {
        sources.set(root, change);
        return { close() {} };
    });
    t.after(() => watcher.close());
    await watcher.setReview(f.id);
    const checkout = sources.get(f.repo);
    const metadata = [...sources].find(([root]) => root !== f.repo)?.[1];
    assert.ok(checkout);
    assert.ok(metadata);
    for (const source of [checkout, metadata, checkout, metadata]) {
        const before = calls;
        source(null);
        await until(() => calls > before);
    }
    await rm(path.join(f.repo, "dir"), { recursive: true });
    await writeFile(path.join(f.repo, "dir"), "directory replaced with a file\n");
    const before = calls;
    checkout("dir/file.ts");
    checkout("dir");
    checkout("file.ts");
    await until(() => calls > before);
    assert.deepEqual(f.logs, []);
});

test("deletion refreshes when a captured untracked file was never inventoried", async (t) => {
    const f = await fixture(t);
    let checkout: ((file: string | null) => void) | undefined;
    const watcher = new ReviewWatcher(f.service, (text) => f.logs.push(text), 10, (root, change) => {
        if (root === f.repo) checkout = change;
        return { close() {} };
    });
    t.after(() => watcher.close());
    await watcher.setReview(f.id);
    assert.ok(checkout);
    const file = path.join(f.repo, "new.ts");
    await writeFile(file, "captured before the watcher inventory\n");
    await mkdir(path.join(f.repo, "node_modules"));
    const ignored = path.join(f.repo, "node_modules", "output.js");
    await writeFile(ignored, "ignored\n");
    await f.service.refresh(f.id);
    assert.ok((await f.service.getSnapshot(f.id)).files.some((entry) => entry.path === "new.ts"));
    await rm(file);
    await rm(ignored);
    checkout("node_modules/output.js");
    checkout("new.ts");
    await until(async () => !(await f.service.getSnapshot(f.id)).files.some((entry) => entry.path === "new.ts"));
    assert.deepEqual(f.logs, []);
});

test("the uncommitted count honors Git's submodule status without adding untracked-only diff entries", async (t) => {
    const f = await fixture(t);
    const source = path.join(f.tmp, "nested");
    const submodule = "vendor/lib";
    await runGit(f.tmp, ["init", "-q", "-b", "main", source]);
    await writeFile(path.join(source, ".gitignore"), "ignored.txt\n");
    await runGit(source, ["add", "."]);
    await runGit(source, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
    await f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", source, submodule);
    await f.git("commit", "-qam", "submodule");
    await writeFile(path.join(f.repo, submodule, "ignored.txt"), "ignored\n");
    const options = { repoRoot: f.repo, base: null, scope: "pending" as const };
    assert.deepEqual((await captureSnapshot(options)).uncommittedFiles, []);

    await writeFile(path.join(f.repo, submodule, "new.txt"), "untracked\n");
    assert.equal((await f.git("status", "--porcelain=v1", "--untracked-files=all")).stdout.trimEnd(), " M vendor/lib");
    assert.equal((await f.git("diff", "--name-only", "HEAD")).stdout, "");
    const snapshot = await captureSnapshot(options);
    assert.deepEqual(snapshot.uncommittedFiles, [submodule]);
    assert.deepEqual(snapshot.files, []);
    assert.deepEqual((await captureSnapshot({ ...options, includeUntracked: false })).uncommittedFiles, []);
    assert.deepEqual((await captureSnapshot({ ...options, exclude: ["vendor"] })).uncommittedFiles, []);
    await f.git("config", `submodule.${submodule}.ignore`, "untracked");
    assert.deepEqual((await captureSnapshot(options)).uncommittedFiles, []);
});

test("ignored submodule events do not refresh even with a subsequent tracked event", async (t) => {
    const f = await fixture(t);
    const source = path.join(f.tmp, "submodule-source");
    await runGit(f.tmp, ["init", "-q", "-b", "main", source]);
    await writeFile(path.join(source, "nested.ts"), "base\n");
    await writeFile(path.join(source, ".gitignore"), "node_modules/\n");
    await runGit(source, ["add", "."]);
    await runGit(source, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
    await f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/lib");
    await f.git("commit", "-qam", "submodule");
    let checkout: ((file: string | null) => void) | undefined;
    let calls = 0;
    const watcher = new ReviewWatcher({
        getReview: (id) => f.service.getReview(id),
        refresh: async () => { calls++; return { revisionId: "r1", created: false, moved: 0 }; },
    }, (text) => f.logs.push(text), 10, (root, change) => {
        if (root === f.repo) checkout = change;
        return { close() {} };
    });
    t.after(() => watcher.close());
    await watcher.setReview(f.id);
    assert.ok(checkout);
    const submodule = path.join(f.repo, "vendor", "lib");
    await mkdir(path.join(submodule, "node_modules"));
    await writeFile(path.join(submodule, "node_modules", "output.js"), "ignored\n");
    checkout("vendor/lib/node_modules");
    checkout("vendor/lib/node_modules/output.js");
    await delay(1000);
    assert.equal(calls, 1, "ignored output does not cause a refresh");
    await rm(path.join(submodule, "node_modules", "output.js"));
    checkout("vendor/lib/node_modules/output.js");
    await delay(1000);
    assert.equal(calls, 1, "deleting ignored output does not cause a refresh");
    await writeFile(path.join(submodule, "nested.ts"), "changed\n");
    checkout("vendor/lib/nested.ts");
    await until(() => calls > 1);
    assert.equal(calls, 2, "only the tracked event causes a refresh");
    assert.deepEqual(f.logs, []);
});

test("submodule working files and stored HEAD metadata trigger superproject refreshes", async (t) => {
    const f = await fixture(t);
    const source = path.join(f.tmp, "submodule-source");
    await runGit(f.tmp, ["init", "-q", "-b", "main", source]);
    await writeFile(path.join(source, "nested.ts"), "base\n");
    await writeFile(path.join(source, ".gitignore"), "node_modules/\n");
    await runGit(source, ["add", "."]);
    await runGit(source, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
    await f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/lib");
    await f.git("commit", "-qam", "submodule");
    await f.watcher.setReview(f.id);
    const submodule = path.join(f.repo, "vendor", "lib");
    const beforeTracked = f.count();
    await writeFile(path.join(submodule, "nested.ts"), "dirty\n");
    await until(async () => (await f.service.getSnapshot(f.id)).files.some((file) => file.path === "vendor/lib"));
    await until(() => f.count() > beforeTracked);
    await mkdir(path.join(submodule, "node_modules"));
    await writeFile(path.join(submodule, "node_modules", "output.js"), "ignored\n");
    assert.equal((await runGit(submodule, ["check-ignore", "node_modules/output.js"])).stdout.trim(), "node_modules/output.js");
    assert.ok(!(await runGit(submodule, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout.includes("node_modules/output.js"));
    await delay(1800);
    const beforeUntracked = f.count();
    const untracked = path.join(submodule, "new.ts");
    await writeFile(untracked, "untracked review content\n");
    await until(() => f.count() > beforeUntracked);
    const beforeDelete = f.count();
    await rm(untracked);
    await until(() => f.count() > beforeDelete);
    const before = f.count();
    await runGit(submodule, ["add", "."]);
    await runGit(submodule, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "updated"]);
    await until(() => f.count() > before);
    await delay(400);
    const after = f.count();
    const head = await runGit(submodule, ["rev-parse", "HEAD"]);
    await runGit(submodule, ["update-ref", "refs/heads/main", `${head.stdout.trim()}^`]);
    await until(() => f.count() > after);
    assert.deepEqual(f.logs, []);
});

test("HEAD/index changes in linked worktrees and shared base refs refresh; close cancels queued work", async (t) => {
    const f = await fixture(t);
    const linked = path.join(f.tmp, "linked");
    await f.git("worktree", "add", "-qb", "feature", linked);
    const id = await f.service.ensureReview({ repoPath: linked, base: "main" });
    await f.watcher.setReview(id);
    const initial = f.count();
    await writeFile(path.join(linked, "file.ts"), "feature\n");
    await until(() => f.count() > initial);
    await runGit(linked, ["add", "file.ts"]);
    let count = f.count();
    await until(() => f.count() > count);
    count = f.count();
    await runGit(linked, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "feature"]);
    await until(async () => (await f.service.getReview(id)).git?.headCommit === (await runGit(linked, ["rev-parse", "HEAD"])).stdout.trim());
    await until(() => f.count() > count);
    count = f.count();
    await f.git("update-ref", "refs/heads/main", (await runGit(linked, ["rev-parse", "HEAD"])).stdout.trim());
    await until(() => f.count() > count);
    await appendFile(path.join(linked, "file.ts"), "queued\n");
    await f.watcher.close();
    const closedCount = f.count();
    await appendFile(path.join(linked, "file.ts"), "after close\n");
    await delay(500);
    assert.equal(f.count(), closedCount);
    assert.deepEqual(f.logs, []);
});

test("switching reviews releases the former checkout and failed setup leaves manual refresh usable", async (t) => {
    const f = await fixture(t);
    await f.watcher.setReview(f.id);
    const other = path.join(f.tmp, "other");
    await f.git("worktree", "add", "-qb", "other", other);
    const otherId = await f.service.ensureReview({ repoPath: other, scope: "pending" });
    await f.watcher.setReview(otherId);
    const count = f.count();
    await writeFile(path.join(f.repo, "file.ts"), "no longer watched\n");
    await delay(400);
    assert.equal(f.count(), count);
    await writeFile(path.join(other, "file.ts"), "watched\n");
    await until(() => f.count() > count);
    await f.watcher.setReview("missing-review");
    assert.match(f.logs[0] ?? "", /automatic refresh unavailable.*Manual Refresh remains available/);
    assert.ok(await f.service.refresh(otherId));
});

test("an open server pushes checkout refreshes and closing the panel stops refreshes", async (t) => {
    const f = await fixture(t);
    const delivery = new Delivery({ service: f.service, send: async () => "unused", reviewIds: () => [f.id] });
    const server = await startReviewServer({
        instanceId: "watch-test", getReviewId: () => f.id, service: f.service, delivery,
        webRoot: fileURLToPath(new URL("../dist/web", import.meta.url)), findPullRequest: async () => null,
    });
    t.after(() => server.close());
    const url = new URL(server.url);
    const events = await fetch(new URL(`/api/events${url.search}`, url), { signal: AbortSignal.timeout(15000) });
    assert.ok(events.body);
    const reader = events.body.getReader();
    try {
        await reader.read(); // Initial hello establishes the live SSE connection.
        await writeFile(path.join(f.repo, "file.ts"), "automatically refreshed\n");
        let received = "";
        while (!received.includes("event: changed")) {
            const event = await reader.read();
            if (event.done) throw new Error("SSE stream closed before the refreshed review event.");
            received += new TextDecoder().decode(event.value);
        }
        assert.match(received, /event: refresh\ndata: \{"status":"refreshing"\}/);
        assert.match(received, /event: changed/);
        await until(async () => (await f.service.getReview(f.id)).currentRevisionId === "r2");
        const response = await fetch(new URL(`/api/state${url.search}`, url));
        const state = await response.json() as { review: { currentRevisionId: string } };
        assert.equal(state.review.currentRevisionId, "r2");
    } finally {
        await reader.cancel();
        await server.close();
    }
    const revision = (await f.service.getReview(f.id)).currentRevisionId;
    await writeFile(path.join(f.repo, "file.ts"), "after panel close\n");
    await delay(700);
    assert.equal((await f.service.getReview(f.id)).currentRevisionId, revision);
});
