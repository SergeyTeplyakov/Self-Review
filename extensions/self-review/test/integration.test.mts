import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile, realpath, cp, appendFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Delivery, ReviewService, SettingsService, Store, git as gitModule, runGit, startReviewServer } from "./modules.mjs";
import type { FileContent, ReviewMessage, ReviewService as ReviewServiceType, ReviewThread } from "../src/lib/review-service.mjs";
import type { SendOptions } from "../src/lib/delivery.mjs";
import type { Store as StoreType } from "../src/lib/store.mjs";
import type { PullRequestInfo } from "../types/contracts.js";

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");
const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";
const git = (cwd: string, ...args: string[]) => runGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args]);

let tmp: string;
let repo: string;
let store: StoreType;
let settings: InstanceType<typeof SettingsService>;
let service: ReviewServiceType;
let delivery: InstanceType<typeof Delivery>;
let sent: SendOptions[];
let reviewId: string;

async function waitFor<T>(predicate: () => T | Promise<T>, label: string, timeoutMs = 5000): Promise<Awaited<T>> {
    const start = Date.now();
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

const deliveryState = async (messageId: string) => (await service.findMessage(reviewId, messageId)).message.delivery?.state;

async function getReview() {
    const review = await service.getReview(reviewId);
    assert.ok(review);
    return review;
}

function required<T>(value: T | null | undefined): T {
    assert.ok(value);
    return value;
}

function availableContent(content: FileContent): Extract<FileContent, { available: true }> {
    assert.ok(content.available);
    return content;
}

function errorHasCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

before(async () => {
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "mr-int-")));
    repo = path.join(tmp, "repo");
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await writeFile(path.join(repo, "a.cs"), lines(20));
    await writeFile(path.join(repo, "keep.txt"), "unchanged\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "base");
    await git(repo, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "a.cs"), lines(20, (i) => (i === 10 ? "line 10 CHANGED" : `line ${i}`)));
    await writeFile(path.join(repo, "notes.md"), "# notes\nhello\n");
    await writeFile(path.join(repo, "agency.toml"), "excluded = true\n");

    store = new Store(path.join(tmp, "data"));
    settings = new SettingsService({ store });
    service = new ReviewService({ store, settings });
    sent = [];
    delivery = new Delivery({
        service,
        send: async (opts) => {
            sent.push(opts);
            return `sm-${sent.length}`;
        },
        reviewIds: () => [reviewId],
    });
});

after(async () => {
    await rm(tmp, { recursive: true, force: true });
});

test("ensureReview captures the working-tree diff vs merge-base with excludes and untracked files", async () => {
    reviewId = await service.ensureReview({ repoPath: repo, base: "main", exclude: ["agency.toml"], title: "Test review" });
    assert.equal(await service.ensureReview({ repoPath: repo, base: "main", exclude: ["agency.toml"] }), reviewId, "same inputs reuse the review");
    const review = await service.getReview(reviewId);
    assert.equal(review.title, "Test review");
    assert.equal(review.currentRevisionId, "r1");
    assert.equal(review.revisions.length, 1, "unchanged tree does not create a revision");
    const snap = await service.getSnapshot(reviewId);
    assert.deepEqual(snap.files.map((f) => [f.path, f.status, f.untracked]), [["a.cs", "modified", false], ["notes.md", "added", true]]);
    assert.equal(snap.branch, "feature");
});

let lineThread: ReviewThread;
let lineMessage: ReviewMessage;

test("a line comment is delivered once with location, and the marker/messageId map tracks processing", async () => {
    const created = await service.createThread(reviewId, { kind: "line", path: "a.cs", side: "new", startLine: 10, endLine: 10, body: "Why CHANGED?", author: "user", clientRequestId: "c-1" });
    lineThread = created.thread;
    lineMessage = created.message;
    assert.equal(lineMessage.delivery?.state, "saving");
    assert.deepEqual(required(lineThread.anchor).selectedLines, ["line 10 CHANGED"]);

    const dup = await service.createThread(reviewId, { kind: "line", path: "a.cs", side: "new", startLine: 10, body: "Why CHANGED?", author: "user", clientRequestId: "c-1" });
    assert.equal(dup.duplicate, true);
    assert.equal((await getReview()).threads.length, 1);

    const result = await delivery.deliver(reviewId, lineThread.threadId, lineMessage.messageId, "inst-1");
    assert.deepEqual(result, { delivered: true, sessionMessageId: "sm-1" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, "enqueue");
    assert.match(sent[0].prompt, new RegExp(`\\[self-review sr:${reviewId}:${lineMessage.messageId}\\]`));
    assert.match(sent[0].prompt, /a\.cs L10/);
    assert.match(sent[0].prompt, /line 10 CHANGED/);
    assert.equal(await deliveryState(lineMessage.messageId), "queued");

    await delivery.onUserMessage({ data: { messageId: "sm-1", content: sent[0].prompt } });
    assert.equal(await deliveryState(lineMessage.messageId), "processing");
});

test("refresh after edits relocates the thread by content", async () => {
    await writeFile(path.join(repo, "a.cs"), "inserted 1\ninserted 2\ninserted 3\n" + lines(20, (i) => (i === 10 ? "line 10 CHANGED" : `line ${i}`)));
    const r = await service.refresh(reviewId);
    assert.equal(r.revisionId, "r2");
    assert.equal(r.created, true);
    const thread = required((await getReview()).threads.find((t) => t.threadId === lineThread.threadId));
    const location = required(thread.location);
    assert.deepEqual([location.revisionId, location.startLine, location.endLine, location.state], ["r2", 13, 13, "current"]);
    assert.equal(required(thread.anchor).startLine, 10, "the original anchor is preserved");
});

test("full-file content matches the revision and reports stale working trees", async () => {
    const content = availableContent(await service.getFileContent(reviewId, "r2", "a.cs"));
    assert.equal(content.lines.length, 23);
    assert.equal(content.lines[12], "line 10 CHANGED");
    const added = availableContent(await service.getFileContent(reviewId, "r2", "notes.md"));
    assert.deepEqual(added.lines, ["# notes", "hello"]);
    await assert.rejects(service.getFileContent(reviewId, "r2", "keep.txt"), /not part of revision/);
    await assert.rejects(service.getFileContent(reviewId, "r2", "../outside.txt"), /escapes/);
    const original = await readFile(path.join(repo, "a.cs"), "utf8");
    await writeFile(path.join(repo, "a.cs"), original.replace("line 10 CHANGED", "line 10 EDITED"));
    try {
        assert.deepEqual(await service.getFileContent(reviewId, "r2", "a.cs"), { revisionId: "r2", path: "a.cs", available: false, reason: "stale", stale: true });
    } finally {
        await writeFile(path.join(repo, "a.cs"), original);
    }
});

test("full-file content rejects edits outside the captured diff hunks", async () => {
    const snapshot = await service.getSnapshot(reviewId, "r2");
    const file = snapshot.files.find((entry) => entry.path === "a.cs");
    assert.equal(required(file).hunks.some((hunk) => hunk.rows.some((row) => row.n === 23)), false);
    const original = await readFile(path.join(repo, "a.cs"), "utf8");
    try {
        await writeFile(path.join(repo, "a.cs"), original.replace("line 20\n", "line 20 EDITED\n"));
        assert.deepEqual(await service.getFileContent(reviewId, "r2", "a.cs"), {
            revisionId: "r2", path: "a.cs", available: false, reason: "stale", stale: true,
        });
    } finally {
        await writeFile(path.join(repo, "a.cs"), original);
    }
});

test("full-file content handles renamed files and empty modified files", async () => {
    const otherRepo = await mkdtemp(path.join(tmp, "content-"));
    await git(otherRepo, "init", "-q", "-b", "main");
    await writeFile(path.join(otherRepo, "old.cs"), lines(30));
    await writeFile(path.join(otherRepo, "empty.cs"), "old line\n");
    await git(otherRepo, "add", ".");
    await git(otherRepo, "commit", "-q", "-m", "base");
    await git(otherRepo, "checkout", "-q", "-b", "feature");
    await git(otherRepo, "mv", "old.cs", "renamed.cs");
    await writeFile(path.join(otherRepo, "renamed.cs"), lines(30, (i) => i === 15 ? "line 15 CHANGED" : `line ${i}`));
    await writeFile(path.join(otherRepo, "empty.cs"), "");
    const otherReviewId = await service.ensureReview({ repoPath: otherRepo, base: "main" });
    const snapshot = await service.getSnapshot(otherReviewId);
    const renamed = snapshot.files.find((entry) => entry.path === "renamed.cs");
    assert.equal(required(renamed).status, "renamed");
    assert.equal(required(renamed).oldPath, "old.cs");
    const content = availableContent(await service.getFileContent(otherReviewId, "r1", "renamed.cs"));
    assert.equal(content.lines[14], "line 15 CHANGED");
    const empty = availableContent(await service.getFileContent(otherReviewId, "r1", "empty.cs"));
    assert.deepEqual(empty.lines, []);
});

test("full-file content handles separated zero-context insertions and deletions", async () => {
    const otherRepo = await mkdtemp(path.join(tmp, "hunks-"));
    await git(otherRepo, "init", "-q", "-b", "main");
    await writeFile(path.join(otherRepo, "a.cs"), lines(100));
    await git(otherRepo, "add", ".");
    await git(otherRepo, "commit", "-q", "-m", "base");
    await git(otherRepo, "checkout", "-q", "-b", "feature");
    const updated: string[] = [];
    for (let i = 1; i <= 100; i++) {
        if (i !== 95) updated.push(i === 5 ? "line 5 CHANGED" : `line ${i}`);
        if (i === 50) updated.push("inserted");
    }
    await writeFile(path.join(otherRepo, "a.cs"), updated.join("\n") + "\n");
    const otherReviewId = await service.ensureReview({ repoPath: otherRepo, base: "main", context: 0 });
    const snapshot = await service.getSnapshot(otherReviewId);
    assert.equal(snapshot.files[0].hunks.length, 3);
    const content = await service.getFileContent(otherReviewId, "r1", "a.cs");
    assert.equal(content.available, true);
    assert.deepEqual(content.lines, updated);
    await writeFile(path.join(otherRepo, "a.cs"), updated.join("\n").replace("line 20\n", "line 20 EDITED\n") + "\n");
    const stale = await service.getFileContent(otherReviewId, "r1", "a.cs");
    assert.equal(stale.available ? null : stale.reason, "stale");
});

test("original-revision full-file drafts recover gaps from saved hunks and immutable renamed-file bases", async () => {
    const otherRepo = await mkdtemp(path.join(tmp, "pinned-"));
    await git(otherRepo, "init", "-q", "-b", "main");
    await writeFile(path.join(otherRepo, "old.ts"), lines(100));
    await git(otherRepo, "add", ".");
    await git(otherRepo, "commit", "-qm", "base");
    await git(otherRepo, "mv", "old.ts", "renamed.ts");
    const updated: string[] = [];
    for (let i = 1; i <= 100; i++) {
        if (i !== 95) updated.push(i === 5 ? "changed line 5" : `line ${i}`);
        if (i === 50) updated.push("inserted");
    }
    await writeFile(path.join(otherRepo, "renamed.ts"), updated.join("\n") + "\n");
    await writeFile(path.join(otherRepo, "new.ts"), "original new file\n");
    const id = await service.ensureReview({ repoPath: otherRepo, base: "main", context: 0 });
    const snapshot = await service.getSnapshot(id);
    const file = required(snapshot.files.find((entry) => entry.path === "renamed.ts"));
    assert.equal(file.oldPath, "old.ts");
    assert.equal(file.hunks.length, 3);
    assert.ok(!file.hunks.some((hunk) => hunk.rows.some((row) => row.n === 20)));
    await writeFile(path.join(otherRepo, "renamed.ts"), "different current content\n");
    await writeFile(path.join(otherRepo, "new.ts"), "different new file\n");
    await service.refresh(id);
    assert.deepEqual(await service.revisionLines(id, "r1", "renamed.ts"), updated);
    assert.deepEqual(await service.revisionLines(id, "r1", "new.ts"), ["original new file"]);
    const { thread } = await service.createThread(id, {
        kind: "line", revisionId: "r1", path: "renamed.ts", side: "new", startLine: 20, body: "Feedback on the original gap",
    });
    assert.deepEqual(required(thread.anchor).selectedLines, ["line 20"]);
    assert.equal(required(thread.anchor).revisionId, "r1");
    assert.equal(required(thread.location).state, "outdated", "removed original code is never silently attached to new code");
});

test("agent reply marks the comment replied and records lessons", async () => {
    const { message } = await service.addMessage(reviewId, lineThread.threadId, {
        author: "agent",
        body: "Renamed.",
        outcome: "changed",
        inReplyTo: lineMessage.messageId,
        verification: "unit tests",
        lessons: [{ scope: "personal", rule: "Explain renames" }],
    });
    assert.equal(message.outcome, "changed");
    assert.equal(await deliveryState(lineMessage.messageId), "replied");
    await delivery.onIdle();
    assert.equal(await deliveryState(lineMessage.messageId), "replied", "idle does not downgrade a replied comment");
    const review = await getReview();
    assert.equal(review.lessons.length, 1);
    assert.equal((await store.readLessons()).length, 1);
    await assert.rejects(
        () => service.addMessage(reviewId, lineThread.threadId, { author: "agent", body: "x", outcome: "bogus" }),
        (e) => errorHasCode(e, "invalid_input"),
    );
});

test("user.message arriving before send() resolves still marks processing; idle settles to no-reply", async () => {
    const { thread, message } = await service.createThread(reviewId, { kind: "overview", body: "Overall: looks fine?", author: "user" });
    let sends = 0;
    const racing = new Delivery({
        service,
        send: async (opts) => {
            sends++;
            if (sends === 1) await racing.onUserMessage({ data: { messageId: "sm-race", content: "no marker" } });
            sent.push(opts);
            return `sm-race-${sends}`.replace("-1", "");
        },
        reviewIds: () => [reviewId],
    });
    await racing.deliver(reviewId, thread.threadId, message.messageId, "inst-1");
    assert.equal(await deliveryState(message.messageId), "processing");
    await racing.onIdle();
    assert.equal(await deliveryState(message.messageId), "no-reply");

    const retried = await racing.deliver(reviewId, thread.threadId, message.messageId, "inst-1", { retry: true });
    assert.equal(retried.delivered, true);
    assert.equal(await deliveryState(message.messageId), "queued");
    assert.equal((await service.findMessage(reviewId, message.messageId)).message.delivery?.attempts, 2);
});

test("a change thread whose code is removed becomes outdated but stays visible", async () => {
    const snap = await service.getSnapshot(reviewId);
    const hunk = required(required(snap.files.find((f) => f.path === "a.cs")).hunks.find((candidate) => candidate.rows.some((row) => row.s === "line 10 CHANGED")));
    const changeRow = required(hunk.rows.find((row) => row.s === "line 10 CHANGED"));
    const lineNumber = required(changeRow.n);
    const { thread } = await service.createThread(reviewId, { kind: "change", path: "a.cs", side: "new", startLine: lineNumber, endLine: lineNumber, body: "Drop this", author: "agent" });
    await writeFile(path.join(repo, "a.cs"), lines(20, (i) => (i === 10 ? "line 10 REWRITTEN" : `line ${i}`)));
    await service.refresh(reviewId);
    const after = required((await getReview()).threads.find((t) => t.threadId === thread.threadId));
    assert.equal(required(after.location).state, "outdated");
    const summary = service.summarize(await getReview());
    assert.ok(summary.threads.some((t) => t.threadId === thread.threadId));
});

test("anchors are validated", async () => {
    const bad = (input: Record<string, unknown>) => assert.rejects(() => service.createThread(reviewId, { author: "user", body: "x", ...input }), (e) => errorHasCode(e, "invalid_input"));
    await bad({ kind: "line", path: "a.cs", startLine: 0 });
    await bad({ kind: "line", path: "a.cs", startLine: 5, endLine: 4 });
    await bad({ kind: "line", path: "a.cs", startLine: 900 });
    await bad({ kind: "file" });
    await bad({ kind: "nope", path: "a.cs" });
    await assert.rejects(() => service.createThread(reviewId, { kind: "file", path: "../outside.txt", body: "x" }));
});

interface HttpJson extends Record<string, unknown> {
    review?: { reviewId: string; currentRevisionId: string };
    files?: unknown[];
    available?: boolean;
    lines?: string[];
    messageId?: string;
    threadId?: string;
    duplicate?: boolean;
    status?: string;
}

interface HttpResponse {
    status: number;
    text: string;
    json: HttpJson | null;
    headers: http.IncomingHttpHeaders;
}

function request(
    port: number,
    { method = "GET", pathName, headers = {}, body }: {
        method?: string;
        pathName: string;
        headers?: http.OutgoingHttpHeaders;
        body?: unknown;
    },
): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: pathName, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if (res.statusCode === undefined) {
                    reject(new Error("HTTP response has no status code."));
                    return;
                }
                let json: HttpJson | null = null;
                try {
                    const parsed: unknown = JSON.parse(text);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as HttpJson;
                } catch {}
                resolve({ status: res.statusCode, text, json, headers: res.headers });
            });
        });
        req.on("error", reject);
        if (body !== undefined) {
            const serialized = typeof body === "string" ? body : JSON.stringify(body);
            if (serialized !== undefined) req.write(serialized);
        }
        req.end();
    });
}

test("comment links use the browser launcher only for authenticated web URLs in the active review", async () => {
    const opened: string[] = [];
    const server = await startReviewServer({
        instanceId: "comment-links", getReviewId: () => reviewId, service, delivery, webRoot: WEB_ROOT,
        openCommentLink: async (url) => {
            if (url === "https://failure.example/") throw new Error("launcher unavailable");
            opened.push(url);
        },
    });
    try {
        const url = new URL(server.url);
        const port = Number(url.port);
        const token = required(url.searchParams.get("t"));
        const headers = { "Content-Type": "application/json", "X-MR-Token": token, "X-MR-Review": reviewId };
        const pathName = "/api/open-comment-link";
        const post = (body: { url: string }, extra: Record<string, string> = {}) =>
            request(port, { method: "POST", pathName, headers: { ...headers, ...extra }, body });
        const body = { url: "HTTPS://example.test/a?x=1&y=two#section" };
        assert.equal((await request(port, { pathName: `${pathName}?t=${token}` })).status, 404);
        assert.equal((await post(body, { "X-MR-Token": "invalid" })).status, 403);
        assert.equal((await post(body, { Origin: "https://example.test" })).status, 403);
        assert.equal((await post(body, { "X-MR-Review": "old-review" })).status, 409);
        for (const url of ["https://", "//example.test/path", "file:///temp/notes"]) {
            assert.equal((await post({ url })).status, 400);
        }
        assert.deepEqual(opened, []);
        assert.equal((await post(body)).status, 200);
        assert.deepEqual(opened, ["https://example.test/a?x=1&y=two#section"]);
        const failure = await post({ url: "https://failure.example/" });
        assert.equal(failure.status, 502);
        assert.match(failure.text, /Could not open the link in the default browser/);
    } finally {
        await server.close();
    }
});

test("HTTP server enforces token/host/origin and delivers posted comments", async () => {
    const extensionVersion = { version: "0.3.0", buildId: "a1b2c3d4e5f6" };
    const server = await startReviewServer({ instanceId: "inst-1", getReviewId: () => reviewId, service, delivery, webRoot: WEB_ROOT, extensionVersion });
    try {
        const url = new URL(server.url);
        const port = Number(url.port);
        const token = required(url.searchParams.get("t"));
        const json = { "Content-Type": "application/json", "X-MR-Token": token };

        const page = await request(port, { pathName: "/" });
        assert.equal(page.status, 200);
        assert.match(page.text, /app\.js/);
        assert.equal((await request(port, { pathName: "/app.js" })).status, 200);
        for (const asset of ["/contracts.mjs", "/settings-api.mjs", "/review-commands.mjs"]) {
            const response = await request(port, { pathName: asset });
            assert.equal(response.status, 200);
            assert.match(response.text, /export /);
        }
        assert.equal((await request(port, { pathName: "/../extension.mjs" })).status, 404);

        assert.equal((await request(port, { pathName: "/api/state" })).status, 403);
        assert.equal((await request(port, { pathName: "/api/state?t=wrong" })).status, 403);
        assert.equal((await request(port, { pathName: `/api/state?t=${token}`, headers: { Host: "evil.example:80" } })).status, 421);
        const state = await request(port, { pathName: `/api/state?t=${token}` });
        assert.equal(state.status, 200);
        const stateJson = required(state.json);
        const stateReview = required(stateJson.review);
        assert.equal(stateReview.reviewId, reviewId);
        assert.deepEqual(stateJson.extensionVersion, extensionVersion, "the running extension build is not inferred from the reviewed checkout");

        const snap = await request(port, { pathName: `/api/snapshot/${stateReview.currentRevisionId}?t=${token}` });
        assert.equal(snap.status, 200);
        assert.ok(Array.isArray(required(snap.json).files));
        assert.equal((await request(port, { pathName: `/api/snapshot/..%2f..%2fx?t=${token}` })).status >= 400, true);

        const contentPath = `/api/content/${stateReview.currentRevisionId}?path=a.cs`;
        assert.equal((await request(port, { pathName: contentPath })).status, 403);
        const content = await request(port, { pathName: `${contentPath}&t=${token}` });
        assert.equal(content.status, 200);
        assert.equal(required(content.json).available, true);
        assert.equal(required(content.json).lines?.[9], "line 10 REWRITTEN");
        assert.equal((await request(port, { pathName: `/api/content/${stateReview.currentRevisionId}?path=..%2Foutside.txt&t=${token}` })).status >= 400, true);

        assert.equal((await request(port, { method: "POST", pathName: `/api/threads?t=${token}`, headers: { "Content-Type": "application/json" }, body: { kind: "overview", body: "x" } })).status, 403, "POST needs the header token");
        assert.equal((await request(port, { method: "POST", pathName: "/api/threads", headers: { ...json, Origin: "http://evil.example" }, body: { kind: "overview", body: "x" } })).status, 403);
        assert.equal((await request(port, { method: "POST", pathName: "/api/threads", headers: { ...json, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
        assert.equal((await request(port, { method: "POST", pathName: "/api/threads", headers: json, body: { kind: "line", path: "a.cs", startLine: -1, body: "x" } })).status, 400);

        const before = sent.length;
        const posted = await request(port, { method: "POST", pathName: "/api/threads", headers: { ...json, Origin: `http://127.0.0.1:${port}` }, body: { kind: "file", path: "notes.md", body: "Is this file needed?", clientRequestId: "http-1" } });
        assert.equal(posted.status, 200);
        const postedJson = required(posted.json);
        const messageId = required(postedJson.messageId);
        const threadId = required(postedJson.threadId);
        await waitFor(async () => (await deliveryState(messageId)) === "queued", "HTTP comment delivery");
        assert.equal(sent.length, before + 1);
        assert.match(required(sent.at(-1)).prompt, /file notes\.md/);

        const again = await request(port, { method: "POST", pathName: "/api/threads", headers: json, body: { kind: "file", path: "notes.md", body: "Is this file needed?", clientRequestId: "http-1" } });
        assert.equal(required(again.json).duplicate, true);
        assert.equal(sent.length, before + 1, "duplicate submit is not re-delivered");

        const reply = await request(port, { method: "POST", pathName: `/api/threads/${threadId}/messages`, headers: json, body: { body: "Follow-up" } });
        assert.equal(reply.status, 200);
        await waitFor(() => sent.length === before + 2, "reply delivery");
        assert.match(required(sent.at(-1)).prompt, /Earlier messages in this thread/);

        const status = await request(port, { method: "POST", pathName: `/api/threads/${threadId}/status`, headers: json, body: { status: "resolved" } });
        assert.deepEqual(status.json, { threadId, status: "resolved" });

        const events = await new Promise<string>((resolve, reject) => {
            const req = http.get({ host: "127.0.0.1", port, path: `/api/events?t=${token}` }, (res) => {
                let buf = "";
                res.on("data", (chunk: Buffer | string) => {
                    buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
                    if (buf.includes("event: changed")) {
                        req.destroy();
                        resolve(buf);
                    }
                });
            });
            req.on("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNRESET" ? null : reject(error)));
            setTimeout(() => service.changed(reviewId, "test"), 100);
        });
        assert.match(events, /event: hello/);
        assert.match(events, /"reason":"test"/);
    } finally {
        await server.close();
    }
});

test("editing a web asset broadcasts 'assets' to open pages; serving the files does not", async () => {
    const webCopy = path.join(tmp, "web-copy");
    await cp(WEB_ROOT, webCopy, { recursive: true });
    const server = await startReviewServer({ instanceId: "inst-assets", getReviewId: () => reviewId, service, delivery, webRoot: webCopy });
    let req;
    try {
        const url = new URL(server.url);
        const port = Number(url.port);
        let seen = "";
        req = http.get({ host: "127.0.0.1", port, path: `/api/events?t=${url.searchParams.get("t")}` }, (res) => res.on("data", (c) => (seen += c)));
        req.on("error", () => {});
        await waitFor(() => seen.includes("event: hello"), "SSE hello");

        for (const asset of ["/", "/app.js", "/styles.css"]) await request(port, { pathName: asset });
        await new Promise((r) => setTimeout(r, 700));
        assert.doesNotMatch(seen, /event: assets/, "reads of the assets are not changes");

        await appendFile(path.join(webCopy, "app.js"), "\n// edited\n");
        await waitFor(() => /event: assets/.test(seen), "assets event after an edit");
    } finally {
        req?.destroy();
        await server.close();
    }
});

test("review data never leaves the data root and the repo is untouched", async () => {
    const status = await runGit(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status.stdout, /\.copilot|review\.json/);
    const review = JSON.parse(await readFile(store.reviewFile(reviewId), "utf8"));
    assert.equal(review.reviewId, reviewId);
});

test("pasted image bytes survive drafts and reopen, and reach SDK attachment options for immediate and batch delivery", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=", "base64");
    const received: SendOptions[] = [];
    const reviewService = new ReviewService({ store });
    const reviewDelivery = new Delivery({ service: reviewService, send: async (options) => {
        received.push(options);
        return `image-message-${received.length}`;
    } });
    const server = await startReviewServer({ instanceId: "images", getReviewId: () => reviewId, service: reviewService, delivery: reviewDelivery, webRoot: WEB_ROOT });
    try {
        const url = new URL(server.url);
        const token = required(url.searchParams.get("t"));
        const endpoint = (suffix: string) => new URL(`/api/${suffix}`, url);
        const headers = { "X-MR-Token": token, "X-MR-Review": reviewId };
        assert.equal((await fetch(endpoint("comment-images"), { method: "POST", body: new Uint8Array(png) })).status, 403);
        assert.equal((await fetch(endpoint("comment-images"), { method: "POST", headers, body: "<svg/>" })).status, 400);
        const upload = await fetch(endpoint("comment-images"), { method: "POST", headers, body: new Uint8Array(png) });
        assert.equal(upload.status, 200);
        const { imageId } = await upload.json() as { imageId: string };
        const imageUrl = endpoint(`comment-images/${imageId}`);
        imageUrl.searchParams.set("review", reviewId);
        assert.equal((await fetch(imageUrl)).status, 403);
        const preview = await fetch(imageUrl, { headers });
        assert.equal(preview.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
        const post = (suffix: string, value: unknown) => fetch(endpoint(suffix), {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(value),
        });
        assert.equal((await post("threads", { kind: "overview", body: "", imageIds: [] })).status, 400);
        const immediate = await post("threads", { kind: "overview", body: "", imageIds: [imageId], draft: false });
        assert.equal(immediate.status, 200);
        const thread = await immediate.json() as { threadId: string; messageId: string };
        await waitFor(() => received[0], "immediate image delivery");
        assert.deepEqual(received[0].attachments, [{ type: "blob", data: png.toString("base64"), mimeType: "image/png", displayName: `${thread.messageId}-image-1` }]);
        assert.ok(received[0].prompt.includes(`${thread.messageId}-image-1`));
        const reply = await post(`threads/${thread.threadId}/messages`, { body: "Compare this", imageIds: [imageId], draft: true });
        assert.equal(reply.status, 200);
        const draft = await reply.json() as { messageId: string };
        const second = await post("threads", { kind: "overview", body: "And this", imageIds: [imageId], draft: true });
        assert.equal(second.status, 200);
        const otherDraft = await second.json() as { messageId: string };
        assert.equal(received.length, 1);
        const reopened = new ReviewService({ store: new Store(store.root) });
        assert.deepEqual((await reopened.findMessage(reviewId, draft.messageId)).message.imageIds, [imageId]);
        assert.ok(!(await readFile(store.reviewFile(reviewId), "utf8")).includes(png.toString("base64")));
        assert.equal((await post("submit", {})).status, 200);
        assert.deepEqual(received[1].attachments, [draft.messageId, otherDraft.messageId].map((id) => ({
            type: "blob", data: png.toString("base64"), mimeType: "image/png", displayName: `${id}-image-1`,
        })));
        assert.ok(received[1].prompt.includes(`${draft.messageId}-image-1`));
        assert.ok(received[1].prompt.includes(`${otherDraft.messageId}-image-1`));
        const large = Buffer.alloc(2 * 1024 * 1024);
        png.copy(large);
        const largeUpload = await fetch(endpoint("comment-images"), { method: "POST", headers, body: new Uint8Array(large) });
        assert.equal(largeUpload.status, 200);
        const largeId = (await largeUpload.json() as { imageId: string }).imageId;
        const drafts: string[] = [];
        for (let i = 0; i < 9; i++) {
            const draftResponse = await post("threads", { kind: "overview", body: `Draft ${i}`, imageIds: [largeId], draft: true });
            assert.equal(draftResponse.status, 200);
            drafts.push((await draftResponse.json() as { messageId: string }).messageId);
        }
        const oversized = await post("submit", {});
        assert.equal(oversized.status, 400);
        assert.match(await oversized.text(), /Send some comments individually/);
        assert.equal(received.length, 2);
        for (const id of drafts) assert.equal((await reopened.findMessage(reviewId, id)).message.delivery?.state, "draft");
        const draftToSend = await reopened.findMessage(reviewId, drafts[0]);
        await reviewDelivery.deliver(reviewId, draftToSend.thread.threadId, drafts[0], "images");
        assert.equal((await post("submit", {})).status, 200);
    } finally {
        await server.close();
    }
});

test("saving a refined batched /learn proposal requires the displayed wording and scope", async () => {
    const savedTo = ".github/copilot-instructions.md";
    const rule = "Place private methods after public methods in classes that follow this layout.";
    const { thread, message: learn } = await service.createThread(reviewId, { kind: "overview", body: "/learn Use this class layout consistently.", hold: true });
    const { message: explain } = await service.addMessage(reviewId, thread.threadId, { body: "/explain", hold: true });
    await service.claimDrafts(reviewId);
    await assert.rejects(service.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: explain.messageId, body: "Wrong source.",
        lessons: [{ sourceMessageId: explain.messageId, rule, status: "proposed" }],
    }), /delivered learning comment/);
    const { message: proposal } = await service.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: explain.messageId, body: "Proposed for approval.",
        lessons: [{ sourceMessageId: learn.messageId, rule, status: "proposed" }],
    });
    assert.equal(await deliveryState(learn.messageId), "replied");
    const lessonId = required(proposal.lessonIds?.[0]);
    const getLesson = async () => required((await getReview()).lessons.find((l) => l.lessonId === lessonId));
    assert.equal((await getLesson()).status, "proposed");
    const refined = "In classes with conventional access ordering, place private methods after public methods.";
    const { message: discussion } = await service.addMessage(reviewId, thread.threadId, { body: "Limit it to classes with conventional access ordering." });
    await service.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: discussion.messageId, body: refined,
        lessons: [{ lessonId, rule: refined, scope: "repo" }],
    });
    const file = path.join(repo, savedTo);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# Existing instructions\n");
    await settings.update(repo, { instructionMappings: [{ pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true }] });
    const server = await startReviewServer({ instanceId: "save-rule", getReviewId: () => reviewId, service, delivery, webRoot: WEB_ROOT });
    try {
        const url = new URL(server.url);
        const headers = { "X-MR-Token": required(url.searchParams.get("t")), "X-MR-Review": reviewId, "Content-Type": "application/json" };
        const save = (rule: string, scope: string) => fetch(new URL(`/api/lessons/${lessonId}/save`, url), {
            method: "POST", headers, body: JSON.stringify({ rule, scope }),
        });
        assert.equal((await save(rule, "repo")).status, 409);
        assert.equal((await save(refined, "personal")).status, 409);
        assert.equal((await getLesson()).status, "proposed");
        assert.equal(await readFile(file, "utf8"), "# Existing instructions\n");
        assert.equal((await save(refined, "repo")).status, 200);
        assert.equal((await save(refined, "repo")).status, 200);
        assert.equal(await readFile(file, "utf8"), `# Existing instructions\n\n- ${refined}\n`);
        const lesson = await getLesson();
        assert.equal(lesson.sourceMessageId, learn.messageId);
        assert.equal(lesson.status, "saved");
        assert.equal(lesson.savedTo, savedTo);
    } finally {
        await server.close();
        await rm(file);
    }
});

test("the agent cannot bypass verification by reporting a rule as saved", async () => {
    const { thread, message } = await service.createThread(reviewId, { kind: "overview", body: "/learn Use this layout." });
    await assert.rejects(service.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: message.messageId, body: "Saved.",
        lessons: [{ rule: "Use this layout for comparable classes.", status: "saved" }],
    }), /lesson.status must be one of proposed, declined/);
    assert.equal(await deliveryState(message.messageId), "saving");
});

for (const other of ["/learn Use this layout.", "/explain Why this layout?", "Use this layout."]) {
    test(`a batch with /learn and "${other}" requires attribution for a new lesson`, async () => {
        const { thread, message: first } = await service.createThread(reviewId, { kind: "overview", body: other, hold: true });
        const { message: second } = await service.addMessage(reviewId, thread.threadId, { body: "/learn Name layout helpers consistently.", hold: true });
        await service.claimDrafts(reviewId);
        const lesson = { rule: "Name layout helpers consistently." };
        const reply = { author: "agent", inReplyTo: first.messageId, body: lesson.rule };
        await assert.rejects(service.addMessage(reviewId, thread.threadId, {
            ...reply, lessons: [lesson],
        }), /sourceMessageId is required/);
        const accepted = await service.addMessage(reviewId, thread.threadId, {
            ...reply, lessons: [{ ...lesson, sourceMessageId: second.messageId }],
        });
        assert.equal((await getReview()).lessons.find((item) => item.lessonId === accepted.message.lessonIds?.[0])?.sourceMessageId, second.messageId);
    });
}

test("a late batch reply can cite an individually retried /learn comment", async () => {
    const { thread, message: learn } = await service.createThread(reviewId, { kind: "overview", body: "/learn Use a predictable layout.", hold: true });
    const { message: explain } = await service.addMessage(reviewId, thread.threadId, { body: "/explain Why?", hold: true });
    await service.claimDrafts(reviewId);
    const batchId = required((await service.findMessage(reviewId, explain.messageId)).message.delivery?.batchId);
    await service.setDelivery(reviewId, learn.messageId, { state: "no-reply" });
    assert.ok(await service.claimDelivery(reviewId, thread.threadId, learn.messageId, { retry: true }));
    await assert.rejects(service.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: learn.messageId, batchId: "wrong-batch", body: "Wrong submission.",
    }), /batchId must identify/);
    const rule = "Use predictable member layouts.";
    const response = await service.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: explain.messageId, batchId, body: rule,
        lessons: [{ rule, sourceMessageId: learn.messageId }],
    });
    const lesson = required((await getReview()).lessons.find((item) => item.lessonId === response.message.lessonIds?.[0]));
    assert.equal(lesson.sourceMessageId, learn.messageId);
    assert.equal((await service.findMessage(reviewId, learn.messageId)).message.delivery?.state, "replied");
});

test("a concurrent save cannot journal before the refinement it saves", async (t) => {
    await settings.update(repo, { instructionMappings: [{ pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true }] });
    const { thread, message } = await service.createThread(reviewId, { kind: "overview", body: "/learn Use explicit options." });
    const reply = await service.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: message.messageId, body: "Use explicit options.", lessons: [{ rule: "Use explicit options." }],
    });
    const id = required(reply.message.lessonIds?.[0]);
    const rule = "Use explicit options in public APIs.";
    const file = path.join(repo, ".github", "copilot-instructions.md");
    t.after(() => rm(file, { force: true }));
    const append = store.appendLesson.bind(store);
    let signalEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    t.mock.method(store, "appendLesson", async (lesson: Parameters<StoreType["appendLesson"]>[0]) => {
        if (lesson.lessonId === id && lesson.status === "proposed") {
            signalEntered();
            await released;
        }
        await append(lesson);
    });
    const refinement = service.addMessage(reviewId, thread.threadId, {
        author: "agent", body: rule, lessons: [{ lessonId: id, rule }],
    });
    await Promise.race([entered, refinement]);
    const saving = service.saveLesson(reviewId, id, { rule, scope: "repo" });
    try {
        assert.equal(await Promise.race([saving.then(() => "saved"), new Promise<string>((resolve) => setTimeout(resolve, 300, "waiting"))]), "waiting");
    } finally {
        release();
        await Promise.all([refinement, saving]);
    }
    assert.equal((await store.readLessons()).find((item) => item.lessonId === id)?.status, "saved");
});

test("retrying a saved guideline repairs its journal after an append failure", async (t) => {
    await settings.update(repo, { instructionMappings: [{ pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true }] });
    const { thread, message } = await service.createThread(reviewId, { kind: "overview", body: "/learn Prefer explicit limits." });
    const rule = "Prefer explicit limits.";
    const reply = await service.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: message.messageId, body: rule, lessons: [{ rule }],
    });
    const id = required(reply.message.lessonIds?.[0]);
    const file = path.join(repo, ".github", "copilot-instructions.md");
    t.after(() => rm(file, { force: true }));
    t.mock.method(store, "appendLesson", async () => { throw new Error("Journal unavailable"); }, { times: 1 });
    await assert.rejects(service.saveLesson(reviewId, id, { rule, scope: "repo" }), /Journal unavailable/);
    assert.equal((await getReview()).lessons.find((item) => item.lessonId === id)?.status, "saved");
    assert.equal((await store.readLessons()).find((item) => item.lessonId === id)?.status, "proposed");
    assert.equal((await service.saveLesson(reviewId, id, { rule, scope: "repo" })).status, "saved");
    assert.equal((await store.readLessons()).find((item) => item.lessonId === id)?.status, "saved");
    assert.equal(await readFile(file, "utf8"), `- ${rule}\n`);
});

test("auto-save verifies a personal guideline in the isolated home, not the repository", async (t) => {
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "self-review-personal-")));
    t.after(() => rm(home, { force: true, recursive: true }));
    t.mock.method(os, "homedir", () => home);
    const auto = new ReviewService({ store, settings, autoSaveLearnedRules: async () => true });
    const rule = "Name reusable test fixtures by their purpose.";
    const { thread, message } = await auto.createThread(reviewId, { kind: "overview", body: `/learn ${rule}` });
    const reply = await auto.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: message.messageId, body: rule, lessons: [{ rule, scope: "personal" }],
    });
    const lesson = required((await getReview()).lessons.find((item) => item.lessonId === reply.message.lessonIds?.[0]));
    assert.equal(lesson.status, "saved");
    const file = path.join(home, ".copilot", "copilot-instructions.md");
    assert.equal(lesson.savedTo, file);
    assert.equal(await readFile(file, "utf8"), `- ${rule}\n`);
    await assert.rejects(readFile(path.join(repo, ".github", "copilot-instructions.md")), { code: "ENOENT" });
});

test("auto-save holds repository rules until a destination mapping is confirmed", async (t) => {
    await settings.update(repo, { instructionMappings: [] });
    const auto = new ReviewService({ store, settings, autoSaveLearnedRules: async () => true });
    const rule = "Keep repository names stable.";
    const { thread, message } = await auto.createThread(reviewId, { kind: "overview", body: `/learn ${rule}` });
    const reply = await auto.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: message.messageId, body: rule,
        lessons: [{ rule, scope: "repo", destination: { kind: "general" } }],
    });
    const lesson = required((await auto.getReview(reviewId)).lessons.find((item) => item.lessonId === reply.message.lessonIds?.[0]));
    assert.equal(lesson.status, "proposed");
    assert.equal(lesson.savedTo, null);
    assert.match(lesson.saveError ?? "", /Choose an instruction destination/);
    await assert.rejects(readFile(path.join(repo, ".github", "copilot-instructions.md")), { code: "ENOENT" });

    await auto.saveLesson(reviewId, lesson.lessonId, {
        rule, scope: "repo", mapping: { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true },
        destination: { kind: "general" },
    });
    const saved = required((await auto.getReview(reviewId)).lessons.find((item) => item.lessonId === lesson.lessonId));
    assert.equal(saved.status, "saved");
    assert.equal(saved.savedTo, ".github/copilot-instructions.md");
});

test("a failed auto-save settings lookup preserves the reply and its proposal", async () => {
    const warnings: string[] = [];
    const auto = new ReviewService({
        store,
        autoSaveLearnedRules: async () => { throw new Error("Repository identity unavailable"); },
        log: (message, level) => { if (level === "warning") warnings.push(message); },
    });
    const rule = "Use clear option names.";
    const { thread, message } = await auto.createThread(reviewId, { kind: "overview", body: `/learn ${rule}` });
    const reply = await auto.addMessage(reviewId, thread.threadId, {
        author: "agent", inReplyTo: message.messageId, body: rule, lessons: [{ rule }],
    });
    const persisted = await getReview();
    assert.ok(persisted.threads.find((item) => item.threadId === thread.threadId)?.messages.some((item) => item.messageId === reply.message.messageId));
    const lesson = required(persisted.lessons.find((item) => item.lessonId === reply.message.lessonIds?.[0]));
    assert.equal(lesson.status, "proposed");
    assert.equal(lesson.savedTo, null);
    assert.equal((await auto.findMessage(reviewId, message.messageId)).message.delivery?.state, "replied");
    assert.match(warnings.join("\n"), /Repository identity unavailable/);
});

test("auto-save writes and verifies both explicit and unsolicited guidelines and leaves failed saves proposed", async () => {
    await settings.update(repo, { instructionMappings: [{ pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true }] });
    const auto = new ReviewService({ store, settings, autoSaveLearnedRules: async () => true });
    const file = path.join(repo, ".github", "copilot-instructions.md");
    await mkdir(path.dirname(file), { recursive: true });
    try {
        for (const body of ["/learn Inline trivial helpers.", "Use clear names for review settings."]) {
            const { thread, message } = await auto.createThread(reviewId, { kind: "overview", body });
            const rule = body.replace(/^\/learn /, "");
            const reply = await auto.addMessage(reviewId, thread.threadId, {
                author: "agent", inReplyTo: message.messageId, body: rule, lessons: [{ rule, destination: { kind: "general" } }],
            });
            const lesson = required((await getReview()).lessons.find((item) => item.lessonId === reply.message.lessonIds?.[0]));
            assert.equal(lesson.status, "saved");
            assert.ok((await readFile(file, "utf8")).split("\n").includes(`- ${rule}`));
        }
        await rm(file);
        await mkdir(file);
        const { thread, message } = await auto.createThread(reviewId, { kind: "overview", body: "/learn Prefer explicit scopes." });
        const reply = await auto.addMessage(reviewId, thread.threadId, {
            author: "agent", inReplyTo: message.messageId, body: "Prefer explicit scopes.", lessons: [{ rule: "Prefer explicit scopes." }],
        });
        const lesson = required((await getReview()).lessons.find((item) => item.lessonId === reply.message.lessonIds?.[0]));
        assert.equal(lesson.status, "proposed");
        assert.equal(lesson.savedTo, null);
        assert.match(lesson.saveError ?? "", /still a proposal/);
    } finally {
        await rm(file, { force: true, recursive: true });
    }
});

test("descriptions persist across reopen, reject stale updates, and are captured with overview comments", async () => {
    assert.equal(service.summarize(await getReview()).description, null, "old reviews need no migration");
    const events: Array<{ reviewId: string; reason: string }> = [];
    const listener = (event: { reviewId: string; reason: string }) => events.push(event);
    service.on("changed", listener);
    try {
        const first = await service.updateDescription(reviewId, { expectedVersion: 0, body: "## Purpose\n\nExplain the change." });
        assert.equal(first.version, 1);
        assert.equal(first.revisionId, (await getReview()).currentRevisionId);
        assert.equal(required(events.at(-1)).reason, "description");
        const reopened = new ReviewService({ store: new Store(path.join(tmp, "data")) });
        await reopened.ensureReview({ reviewId });
        assert.deepEqual(required(await reopened.getReview(reviewId)).description, first);
        const { thread, message } = await service.createThread(reviewId, { kind: "overview", body: "Revise this description", descriptionVersion: 1 });
        assert.deepEqual(message.descriptionContext, first);
        const updates = await Promise.allSettled([
            service.updateDescription(reviewId, { expectedVersion: 1, body: "## Purpose\n\nSecond version." }),
            service.updateDescription(reviewId, { expectedVersion: 1, body: "Concurrent edit." }),
        ]);
        assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
        const rejectedUpdate = updates.find((result): result is PromiseRejectedResult => result.status === "rejected");
        assert.ok(rejectedUpdate);
        assert.ok(errorHasCode(rejectedUpdate.reason, "conflict"));
        assert.equal(required((await service.findMessage(reviewId, message.messageId)).message.descriptionContext).body, first.body);
        await assert.rejects(() => service.createThread(reviewId, { kind: "overview", body: "Stale comment", descriptionVersion: 1 }), (error) => errorHasCode(error, "conflict"));
        await assert.rejects(() => service.addMessage(reviewId, thread.threadId, { body: "Stale reply", descriptionVersion: 1 }), (error) => errorHasCode(error, "conflict"));
        for (const body of ["", "x".repeat(20001)]) {
            await assert.rejects(() => service.updateDescription(reviewId, { expectedVersion: 2, body }), (error) => errorHasCode(error, "invalid_input"));
        }
        await service.addMessage(reviewId, thread.threadId, { author: "agent", inReplyTo: message.messageId, body: "Updated.", outcome: "changed" });
        await service.setThreadStatus(reviewId, thread.threadId, "resolved");
        const reply = await service.addMessage(reviewId, thread.threadId, { body: "One more point", descriptionVersion: 2 });
        assert.equal(reply.thread.status, "active", "user follow-up reopens a resolved thread");
        assert.equal(required(reply.message.descriptionContext).version, 2);
    } finally {
        service.off("changed", listener);
    }
});

test("state returns the latest Overview after slow PR discovery and exposes capture progress and failures", async (t) => {
    let releaseDiscovery = () => {};
    let discoveryStarted = () => {};
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const discovery = new Promise<void>((resolve) => { discoveryStarted = resolve; });
    const server = await startReviewServer({
        instanceId: "loading-state", getReviewId: () => reviewId, service, delivery, webRoot: WEB_ROOT,
        findPullRequest: async (repoPath, branch) => {
            assert.equal(repoPath, repo);
            assert.equal(branch, "feature");
            discoveryStarted();
            await discoveryGate;
            return {
                number: 42, url: "https://github.com/example/repo/pull/42", state: "open",
                baseRefName: "main", headRefOid: null, mergedAt: null, closedAt: null, mergeCommitOid: null,
            };
        },
    });
    t.after(() => server.close());
    t.after(() => releaseDiscovery());
    const url = new URL(server.url);
    const readState = async (): Promise<{
        review: { description: { body: string }; branch?: string | null };
        refresh: { status: string; error?: string };
        pullRequest: { number: number; url: string } | null;
        pullRequestStatus: unknown;
    }> => {
        const response = await fetch(new URL(`/api/state${url.search}`, url));
        assert.equal(response.status, 200);
        return response.json();
    };
    const pending = readState();
    await discovery;
    await store.updateReview(reviewId, (review) => {
        assert.ok(review);
        review.branch = "other-branch";
        return { review };
    });
    await service.updateDescription(reviewId, { expectedVersion: (await getReview()).description?.version ?? 0, body: "Updated during discovery" });
    releaseDiscovery();
    const latest = await pending;
    assert.equal(latest.review.description.body, "Updated during discovery");
    assert.equal(latest.review.branch, "other-branch");
    assert.equal(latest.pullRequest, null, "PR metadata discovered for the old branch is not paired with the newer review");
    assert.equal(latest.pullRequestStatus, null);
    assert.equal(latest.refresh.status, "idle");

    let releaseCapture = () => {};
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    t.after(() => releaseCapture());
    const capture = t.mock.method(service, "refreshOnce", async () => {
        await captureGate;
        throw new Error("capture failed");
    });
    const refreshing = service.refresh(reviewId);
    const rejected = assert.rejects(refreshing, /capture failed/);
    assert.equal((await readState()).refresh.status, "refreshing");
    releaseCapture();
    await rejected;
    assert.deepEqual((await readState()).refresh, { status: "error", error: "capture failed" });
    capture.mock.restore();
    await service.refresh(reviewId);
    assert.equal((await readState()).refresh.status, "idle");
});

test("a merged pull request completes the review: history keeps dispositions, later work stays active, follow-ups are held drafts", async (t) => {
    const root = path.join(tmp, "merged-pr");
    const prRepo = path.join(root, "repo");
    await mkdir(root, { recursive: true });
    await runGit(root, ["init", "-q", "-b", "main", prRepo]);
    await writeFile(path.join(prRepo, "app.ts"), lines(10));
    await git(prRepo, "add", ".");
    await git(prRepo, "commit", "-q", "-m", "base");
    await git(prRepo, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(prRepo, "app.ts"), lines(10, (i) => (i === 3 ? "line 3 PR" : `line ${i}`)));
    await git(prRepo, "commit", "-q", "-am", "pull request work");
    const prHead = (await git(prRepo, "rev-parse", "HEAD")).stdout.trim();
    // GitHub squash-merges into main, so the branch commits never become ancestors of the base.
    await git(prRepo, "checkout", "-q", "main");
    await writeFile(path.join(prRepo, "app.ts"), lines(10, (i) => (i === 3 ? "line 3 PR" : `line ${i}`)));
    await git(prRepo, "commit", "-q", "-am", "squashed pull request");
    const squash = (await git(prRepo, "rev-parse", "HEAD")).stdout.trim();
    await git(prRepo, "checkout", "-q", "feature");

    let gitBusy = false;
    const prService = new ReviewService({ store: new Store(path.join(root, "data")), git: { ...gitModule, commitsAfter: async (repoRoot: string, oid: string) => {
        if (gitBusy) throw new Error("git is busy");
        return gitModule.commitsAfter(repoRoot, oid);
    } } });
    const prompts: SendOptions[] = [];
    const prDelivery = new Delivery({ service: prService, send: async (options) => {
        prompts.push(options);
        return `pr-message-${prompts.length}`;
    } });
    const prReviewId = await prService.ensureReview({ repoPath: prRepo, base: "main" });
    const unresolved = (await prService.createThread(prReviewId, { kind: "line", path: "app.ts", side: "new", startLine: 3, endLine: 3, body: "Is line 3 right?", author: "user", hold: true })).thread;
    const resolved = (await prService.createThread(prReviewId, { kind: "overview", body: "Add a test", author: "user", hold: true })).thread;
    await prService.setThreadStatus(prReviewId, resolved.threadId, "resolved");
    const inFlight = (await prService.createThread(prReviewId, { kind: "overview", body: "Rename the helper", author: "user", hold: true })).thread;
    await prDelivery.deliver(prReviewId, inFlight.threadId, inFlight.messages[0].messageId, "merged-pr");
    assert.equal(prompts.length, 1);
    prompts.length = 0;
    const unsent = (await prService.createThread(prReviewId, { kind: "overview", body: "Never sent", author: "user" })).thread;
    assert.equal(unsent.messages[0].delivery?.state, "saving");
    const mergedAt = new Date().toISOString();

    const open: PullRequestInfo = { number: 5, url: "https://github.com/example/repo/pull/5", state: "open", baseRefName: "main", headRefOid: prHead, mergedAt: null, closedAt: null, mergeCommitOid: null };
    let lookup = async (): Promise<PullRequestInfo | null> => { throw new Error("gh offline"); };
    const server = await startReviewServer({
        instanceId: "merged-pr", getReviewId: () => prReviewId, service: prService, delivery: prDelivery, webRoot: WEB_ROOT,
        findPullRequest: async () => lookup(),
    });
    t.after(() => server.close());
    const url = new URL(server.url);
    const token = required(url.searchParams.get("t"));
    const endpoint = (suffix: string) => new URL(`/api/${suffix}`, url);
    type State = {
        review: { threads: ReviewThread[]; completions?: Array<{ archivedThreadIds: string[]; deliveredRevisionId: string | null }>; currentRevisionId: string; git: { delivered?: { separation: string } } };
        pullRequest: PullRequestInfo | null;
        pullRequestStatus: { checkedAt: string | null; error: string | null; commitsAfterHead: number | null } | null;
    };
    const readState = async (): Promise<State> => {
        const response = await fetch(endpoint(`state?pullRequest=refresh&t=${token}`));
        assert.equal(response.status, 200);
        return await response.json() as State;
    };
    const post = (suffix: string, value: unknown) => fetch(endpoint(suffix), {
        method: "POST", headers: { "X-MR-Token": token, "X-MR-Review": prReviewId, "Content-Type": "application/json" }, body: JSON.stringify(value),
    });
    const thread = (state: State, threadId: string) => required(state.review.threads.find((x) => x.threadId === threadId));

    let state = await readState();
    assert.equal(state.pullRequestStatus?.error, "gh offline");
    assert.equal(state.pullRequest, null);
    assert.equal(state.review.completions?.length ?? 0, 0, "a failed lookup never completes the review");

    await writeFile(path.join(prRepo, "later.ts"), "after the pull request\n");
    await git(prRepo, "add", "later.ts");
    await git(prRepo, "commit", "-q", "-m", "later work");
    await writeFile(path.join(prRepo, "notes.md"), "uncommitted\n");
    lookup = async () => open;
    gitBusy = true;
    state = await readState();
    assert.equal(state.pullRequest?.state, "open");
    assert.equal(state.pullRequestStatus?.commitsAfterHead, null, "a failed count only hides the pill");
    gitBusy = false;
    state = await readState();
    assert.deepEqual(state.pullRequestStatus && { error: state.pullRequestStatus.error, commitsAfterHead: state.pullRequestStatus.commitsAfterHead }, { error: null, commitsAfterHead: 1 }, "a failed count is not cached");
    assert.equal(state.review.completions?.length ?? 0, 0);

    lookup = async () => ({ ...open, state: "merged", mergedAt, closedAt: mergedAt, mergeCommitOid: squash });
    state = await readState();
    const completion = required(state.review.completions?.[0]);
    assert.deepEqual(completion.archivedThreadIds, [unresolved.threadId, resolved.threadId, inFlight.threadId, unsent.threadId]);
    assert.equal(completion.deliveredRevisionId, "r1");
    assert.equal(thread(state, unresolved.threadId).status, "active", "archiving does not mark a finding fixed");
    assert.equal(thread(state, resolved.threadId).status, "resolved");
    assert.equal(state.review.git.delivered?.separation, "separated");
    const active = await prService.getSnapshot(prReviewId, state.review.currentRevisionId);
    assert.deepEqual(active.files.map((f) => f.path), ["later.ts", "notes.md"], "only work after the PR head stays active");
    assert.equal((await readState()).review.completions?.length, 1, "a merge is recorded once");

    lookup = async () => { throw new Error("rate limited"); };
    state = await readState();
    assert.equal(state.pullRequestStatus?.error, "rate limited");
    assert.equal(state.pullRequest?.state, "merged", "the last known result is kept, marked stale");
    assert.equal(state.review.completions?.length, 1);

    assert.equal((await post(`threads/${unresolved.threadId}/messages`, { body: "Still wrong" })).status, 409);
    assert.equal((await post(`threads/${resolved.threadId}/status`, { status: "active" })).status, 409);
    assert.equal((await post(`messages/${unresolved.messages[0].messageId}/send`, {})).status, 409);
    // Canvas actions call the service directly, so history is enforced there too.
    const archivedError = /moved to review history/;
    await assert.rejects(prService.setThreadStatus(prReviewId, unresolved.threadId, "resolved"), archivedError);
    await assert.rejects(prService.addMessage(prReviewId, resolved.threadId, { author: "agent", body: "Done", outcome: "answered" }), archivedError);
    await assert.rejects(prService.claimDelivery(prReviewId, unresolved.threadId, unresolved.messages[0].messageId), archivedError);
    await assert.rejects(prService.discardDraft(prReviewId, unresolved.messages[0].messageId), archivedError);
    await assert.rejects(prService.addMessage(prReviewId, unsent.threadId, { author: "agent", body: "Done", outcome: "answered" }), archivedError,
        "a comment never dispatched before the merge cannot be answered");
    const late = await prService.addMessage(prReviewId, inFlight.threadId, { author: "agent", body: "Renamed it", outcome: "answered" });
    assert.equal(late.thread.messages[0].delivery?.state, "replied", "the agent can still answer a comment sent before the merge");
    await assert.rejects(prService.addMessage(prReviewId, inFlight.threadId, { author: "agent", body: "One more thing", outcome: "answered" }), archivedError);
    assert.equal(thread(await readState(), unresolved.threadId).status, "active");
    assert.equal((await post("submit", {})).status, 200);
    assert.equal(prompts.length, 0, "Submit review leaves archived drafts in history");
    assert.equal((await post("follow-up", { threadIds: ["missing"] })).status, 400);

    const followUp = await post("follow-up", { threadIds: [unresolved.threadId] });
    assert.equal(followUp.status, 200);
    const [followUpId] = (await followUp.json() as { threadIds: string[] }).threadIds;
    const later = await post("threads", { kind: "overview", body: "New work", draft: true });
    const laterId = (await later.json() as { threadId: string }).threadId;
    state = await readState();
    const created = thread(state, followUpId);
    assert.equal(created.followUpOf, unresolved.threadId);
    assert.equal(created.kind, "overview", "the original line is no longer in the active diff");
    assert.equal(created.messages[0].delivery?.state, "draft");
    assert.match(created.messages[0].body, /Is line 3 right\?/);
    assert.equal(thread(state, unresolved.threadId).messages.length, 1, "the original thread is not modified");
    assert.ok(![followUpId, laterId].some((id) => completion.archivedThreadIds.includes(id)));
    assert.deepEqual(required(state.review.completions?.[0]).archivedThreadIds, completion.archivedThreadIds);
    assert.equal(prompts.length, 0, "starting a follow-up sends nothing");

    // A review first opened after the merge has no pre-merge revision, so it claims no delivered diff.
    const lateService = new ReviewService({ store: new Store(path.join(root, "late-data")) });
    const lateId = await lateService.ensureReview({ repoPath: prRepo, base: "main" });
    assert.ok(await lateService.recordCompletion(lateId, { ...open, state: "merged", mergedAt: "2000-01-01T00:00:00Z", closedAt: "2000-01-01T00:00:00Z", mergeCommitOid: squash }, "feature"));
    assert.equal(required((await lateService.getReview(lateId)).completions?.[0]).deliveredRevisionId, null);
});
