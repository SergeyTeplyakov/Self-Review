import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Delivery, ReviewService, SettingsService, Store, runGit } from "./modules.mjs";
import type { SendOptions } from "../src/lib/delivery.mjs";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function fixture(t: TestContext, limit: number | null = 2, afterSend: (options: SendOptions) => Promise<void> = async () => {}) {
    const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "sr-parallel-test-")));
    const root = path.join(tmp, "repo");
    t.after(() => rm(tmp, { recursive: true, force: true }));
    await runGit(tmp, ["init", "-q", "-b", "main", root]);
    const write = (file: string, value: string) => writeFile(path.join(root, file), value);
    const read = (file: string) => readFile(path.join(root, file), "utf8");
    await Promise.all(["a.txt", "b.txt", "c.txt"].map(file => write(file, "committed")));
    await runGit(root, ["add", "."]);
    await runGit(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
    await write("a.txt", "user uncommitted");
    await write("untracked.txt", "user untracked");
    const store = new Store(path.join(tmp, "store"));
    const service = new ReviewService({ store });
    const settings = new SettingsService({ store });
    if (limit !== null) await settings.update(root, { commentConcurrency: limit });
    const reviewId = await service.ensureReview({ repoPath: root, scope: "pending" });
    const sent: SendOptions[] = [];
    const delivery = new Delivery({
        service, settings,
        autoSaveLearnedRules: async repoRoot => (await settings.get(repoRoot)).autoSaveLearnedRules,
        send: async options => {
            sent.push(options);
            await afterSend(options);
            return `send-${sent.length}`;
        },
    });
    t.after(async () => {
        for (const options of sent) await delivery.onUserMessage({ data: { content: options.prompt } });
        await delivery.onIdle();
    });
    const newThread = (body: string, hold = false) => service.createThread(reviewId, { kind: "overview", body, hold });
    const send = async ({ thread, message }: Awaited<ReturnType<typeof newThread>>) =>
        delivery.deliver(reviewId, thread.threadId, message.messageId, "parallel-test");
    const runId = () => {
        const marker = /^\[self-review parallel:([^\]]+)\]/.exec(sent.at(-1)?.prompt ?? "");
        assert.ok(marker);
        return marker[1];
    };
    return { delivery, sent, service, settings, reviewId, root, read, write, newThread, send, runId };
}

const changed = { body: "Implemented and checked.", outcome: "changed", verification: "fixture check passed" };
const answered = { body: "Here is the explanation.", outcome: "answered" };
const proposed = { body: "Re-read a.txt, update its value, then read it back.", outcome: "proposed" };

test("parallel processing is opt-in per repository and switching back restores serial delivery", async t => {
    const f = await fixture(t, null);
    const other = path.join(path.dirname(f.root), "other");
    await runGit(path.dirname(other), ["clone", "--quiet", f.root, other]);
    const otherReview = await f.service.ensureReview({ repoPath: other, scope: "pending" });
    const dispatch = async (reviewId: string) => {
        const { thread, message } = await f.service.createThread(reviewId, { kind: "overview", body: "What is in a.txt?" });
        const result = await f.delivery.deliver(reviewId, thread.threadId, message.messageId, "parallel-test");
        assert.equal(result.delivered, true);
        return f.sent.at(-1)?.prompt ?? "";
    };

    assert.match(await dispatch(f.reviewId), /^\[self-review sr:/);
    await f.settings.update(f.root, { commentConcurrency: 2 });
    assert.match(await dispatch(f.reviewId), /^\[self-review parallel:/);
    const run = f.runId();
    assert.match(await dispatch(otherReview), /^\[self-review sr:/);
    const { jobs } = await f.delivery.parallel.take(run);
    assert.equal(jobs.length, 1);
    await f.delivery.parallel.finish(run, jobs[0].jobId, answered);
    assert.equal((await f.delivery.parallel.take(run)).done, true);

    await f.settings.update(f.root, { commentConcurrency: 1 });
    assert.match(await dispatch(f.reviewId), /^\[self-review sr:/);
});

test("submitting drafts keeps the whole review together, even when a parallel limit is saved", async t => {
    const f = await fixture(t, 3);
    for (const mode of ["batch", "ask", "immediate"] as const) {
        await f.settings.update(f.root, { delivery: mode });
        if (mode === "ask") await f.service.setDeliveryChoice(f.reviewId, "batch");
        await f.newThread("Rename the helper", true);
        await f.newThread("Update its callers too", true);
        const before = f.sent.length;
        const result = await f.delivery.submit(f.reviewId, "parallel-test");
        assert.equal(result.submitted, 2);
        assert.equal(f.sent.length, before + 1);
        assert.match(f.sent[before].prompt, /with 2 comments in 2 threads/);
        assert.equal(f.sent[before].mode, "enqueue");

        await f.send(await f.newThread("Send this one now", true));
        assert.equal(f.sent.at(-1)?.mode, mode === "immediate" ? "immediate" : "enqueue");
    }
});

test("immediate follow-ups stay queued behind a pending combined submission in the same thread", async t => {
    const f = await fixture(t, 3);
    await f.settings.update(f.root, { delivery: "batch" });
    const first = await f.newThread("First batch comment", true);
    await f.service.addMessage(f.reviewId, first.thread.threadId, { author: "user", body: "Second batch comment", hold: true });
    await f.delivery.submit(f.reviewId, "parallel-test");
    assert.match(f.sent[0].prompt, /with 2 comments in 1 thread/);

    await f.settings.update(f.root, { delivery: "immediate" });
    const followUp = await f.service.addMessage(f.reviewId, first.thread.threadId, { author: "user", body: "Immediate follow-up" });
    await f.delivery.deliver(f.reviewId, first.thread.threadId, followUp.message.messageId, "parallel-test");

    assert.equal(f.sent[1].mode, "enqueue");
    assert.doesNotMatch(f.sent[1].prompt, /^\[self-review parallel:/);
});

test("immediate follow-ups wait until a combined submission reaches the session queue", async t => {
    const sendStarted = deferred();
    const releaseBatch = deferred();
    const followUpSent = deferred();
    const completed: string[] = [];
    const f = await fixture(t, 3, async options => {
        if (options.prompt.includes("with 2 comments in 1 thread")) {
            sendStarted.resolve();
            await releaseBatch.promise;
            completed.push("batch");
        } else if (options.prompt.includes("Immediate follow-up")) {
            followUpSent.resolve();
            completed.push("follow-up");
        }
    });
    await f.settings.update(f.root, { delivery: "batch" });
    const first = await f.newThread("First batch comment", true);
    await f.service.addMessage(f.reviewId, first.thread.threadId, { author: "user", body: "Second batch comment", hold: true });
    const submission = f.delivery.submit(f.reviewId, "parallel-test");
    await sendStarted.promise;

    await f.settings.update(f.root, { delivery: "immediate" });
    const followUp = await f.service.addMessage(f.reviewId, first.thread.threadId, { author: "user", body: "Immediate follow-up" });
    const followUpDelivery = f.delivery.deliver(f.reviewId, first.thread.threadId, followUp.message.messageId, "parallel-test");
    const sentBeforeRelease = await Promise.race([
        followUpSent.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    releaseBatch.resolve();
    await Promise.all([submission, followUpDelivery]);
    assert.equal(sentBeforeRelease, false);
    assert.deepEqual(completed, ["batch", "follow-up"]);
});

test("parallel follow-ups wait for earlier claims to finish routing", async t => {
    const firstSettingsRead = deferred();
    const releaseFirstSettings = deferred();
    const laterSend = deferred();
    const f = await fixture(t, 3, async options => {
        if (options.prompt.includes("Second comment")) laterSend.resolve();
    });
    const getSettings = f.settings.get.bind(f.settings);
    let settingsReads = 0;
    f.settings.get = async (...args) => {
        const settings = await getSettings(...args);
        if (++settingsReads === 1) {
            firstSettingsRead.resolve();
            await releaseFirstSettings.promise;
        }
        return settings;
    };

    const first = await f.newThread("First comment");
    const firstDelivery = f.send(first);
    await firstSettingsRead.promise;
    const second = await f.newThread("Second comment");
    const secondClaimed = deferred();
    const onChanged = (event: { reviewId: string; reason: string }) => {
        if (event.reviewId === f.reviewId && event.reason === "delivery") {
            f.service.off("changed", onChanged);
            secondClaimed.resolve();
        }
    };
    f.service.on("changed", onChanged);
    const secondDelivery = f.send(second);
    await secondClaimed.promise;
    const sentBeforeRelease = await Promise.race([
        laterSend.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    releaseFirstSettings.resolve();
    await Promise.all([firstDelivery, secondDelivery]);
    assert.equal(sentBeforeRelease, false);
    assert.match(f.sent[0].prompt, /^\[self-review parallel:/);
    assert.match(f.sent[1].prompt, /^\[self-review parallel:/);
    const firstRun = /^\[self-review parallel:([^\]]+)\]/.exec(f.sent[0].prompt)?.[1];
    const secondRun = /^\[self-review parallel:([^\]]+)\]/.exec(f.sent[1].prompt)?.[1];
    assert.equal(secondRun, firstRun);
});

test("parallel processing starts newly eligible work while earlier workers are still running", async t => {
    const f = await fixture(t);
    await f.settings.update(f.root, { autoSaveLearnedRules: true });
    const a = await f.newThread("Change a.txt", true);
    const addFollowUp = () => f.service.addMessage(f.reviewId, a.thread.threadId, { author: "user", body: "Also update it again", hold: true });
    const followup = await addFollowUp();
    const b = await f.newThread("Change b.txt", true);
    const c = await f.newThread("Explain c.txt", true);
    await f.settings.update(f.root, { delivery: "ask" });
    await f.service.setDeliveryChoice(f.reviewId, "immediate");
    const result = await f.delivery.submit(f.reviewId, "parallel-test", "immediate");
    assert.equal(result.submitted, 4);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].mode, "immediate");
    const run = f.runId();
    const take = () => f.delivery.parallel.take(run);
    const wave = await take();
    assert.equal(wave.jobs.length, 2, JSON.stringify((await f.service.findMessage(f.reviewId, a.message.messageId)).message.delivery));
    assert.match(wave.jobs[0].prompt, /Change a\.txt/);
    assert.doesNotMatch(wave.jobs[0].prompt, /Also update it again/);
    assert.match(wave.jobs[1].prompt, /Change b\.txt/);
    assert.deepEqual(await take(), { done: false, jobs: [] }, "full capacity waits for a worker result without rejecting the run");
    for (const entry of [a, b]) {
        assert.equal((await f.service.findMessage(f.reviewId, entry.message.messageId)).message.delivery?.state, "processing");
    }
    for (const entry of [followup, c]) {
        assert.equal((await f.service.findMessage(f.reviewId, entry.message.messageId)).message.delivery?.state, "queued");
    }
    for (const { prompt } of wave.jobs) {
        assert.ok(prompt.includes(`read-only in the reviewed checkout ${JSON.stringify(f.root)}`));
        assert.match(prompt, /Auto-save learned rules is on/);
        assert.doesNotMatch(prompt, /make the smallest complete change in the working tree/);
    }
    const [jobA, jobB] = wave.jobs;
    const finish = (id: string, report: { body: string; outcome: string; verification?: string }) => f.delivery.parallel.finish(run, id, report);
    assert.equal((await finish(jobA.jobId, proposed)).outcome, "proposed");
    assert.equal(await f.read("a.txt"), "user uncommitted");
    const nextWorker = await take();
    assert.equal(nextWorker.jobs.length, 1, "the free slot admits the next independent thread before job B finishes");
    assert.match(nextWorker.jobs[0].prompt, /Explain c\.txt/);
    const [jobC] = nextWorker.jobs;
    await finish(jobB.jobId, answered);
    assert.deepEqual(await take(), { done: false, jobs: [] }, "the edit waits for the admitted analysis to finish");
    await finish(jobC.jobId, answered);
    assert.equal((await take()).edit?.jobId, jobA.jobId);
    assert.deepEqual(await take(), { done: false, jobs: [] }, "an applying edit remains the sole writer");
    await f.write("a.txt", "modified a");
    assert.equal(await f.read("a.txt"), "modified a");
    assert.equal((await finish(jobA.jobId, changed)).outcome, "changed");
    assert.deepEqual(await finish(jobA.jobId, changed), { accepted: false }, "a duplicate result cannot reply twice");
    assert.equal((await runGit(f.root, ["diff", "--cached", "--name-only"])).stdout, "");
    assert.equal((await f.service.findMessage(f.reviewId, followup.message.messageId)).message.delivery?.state, "queued",
        "reply to one batch comment does not prematurely answer the rest of the thread");
    const second = await take();
    assert.equal(second.jobs.length, 1);
    assert.match(second.jobs[0].prompt, /Also update it again/);
    assert.match(second.jobs[0].prompt, /Implemented and checked/);
    assert.ok(second.jobs[0].prompt.includes(JSON.stringify(f.root)));
    await finish(second.jobs[0].jobId, answered);
    assert.deepEqual(await take(), { done: true, jobs: [] });
    const thread = (await f.service.findMessage(f.reviewId, a.message.messageId)).thread;
    assert.deepEqual(thread.messages.filter(msg => msg.author === "agent").map(msg => msg.inReplyTo),
        [a.message.messageId, followup.message.messageId]);
});

test("a newly submitted independent comment immediately wakes the active run and fills a free slot", async t => {
    const f = await fixture(t);
    const a = await f.newThread("Explain a.txt");
    await f.send(a);
    const run = f.runId();
    const first = await f.delivery.parallel.take(run);
    assert.equal(first.jobs.length, 1);

    const b = await f.newThread("Explain b.txt");
    await f.send(b);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].mode, "immediate");
    assert.ok(f.sent[1].prompt.startsWith(`[self-review parallel:${run}]`));

    const second = await f.delivery.parallel.take(run);
    assert.equal(second.jobs.length, 1);
    assert.match(second.jobs[0].prompt, /Explain b\.txt/);
    await f.delivery.parallel.finish(run, first.jobs[0].jobId, answered);
    await f.delivery.parallel.finish(run, second.jobs[0].jobId, answered);
    assert.deepEqual(await f.delivery.parallel.take(run), { done: true, jobs: [] });
});

test("re-analyze a stale proposal after an earlier edit and after a user's concurrent edit", async t => {
    const f = await fixture(t);
    const [a, b] = await Promise.all([f.newThread("Update a"), f.newThread("Update a and b")]);
    await f.send(a);
    await f.send(b);
    const run = f.runId();
    const wave = await f.delivery.parallel.take(run);
    const [first, second] = wave.jobs;
    for (const job of wave.jobs) await f.delivery.parallel.finish(run, job.jobId, proposed);
    assert.equal((await f.delivery.parallel.take(run)).edit?.jobId, first.jobId);
    await f.write("a.txt", "first edit");
    assert.equal((await f.delivery.parallel.finish(run, first.jobId, changed)).outcome, "changed");
    const next = await f.delivery.parallel.take(run);
    assert.equal(next.edit, undefined);
    assert.equal(next.jobs[0].jobId, second.jobId);
    await f.delivery.parallel.finish(run, second.jobId, proposed);
    await f.write("a.txt", "user changed it");
    assert.equal((await f.delivery.parallel.take(run)).jobs[0].jobId, second.jobId);
    await f.delivery.parallel.finish(run, second.jobId, { outcome: "needs-input", body: "The updated requirements conflict." });
    assert.equal(await f.read("a.txt"), "user changed it");
    assert.equal(await f.read("b.txt"), "committed");
    assert.deepEqual(await f.delivery.parallel.take(run), { done: true, jobs: [] });
    for (const entry of [a, b]) {
        const thread = (await f.service.findMessage(f.reviewId, entry.message.messageId)).thread;
        assert.equal(thread.messages.filter(msg => msg.author === "agent" && msg.inReplyTo === entry.message.messageId).length, 1);
    }
});

test("read-only comments cannot integrate edits and an interrupted host turn never runs serially", async t => {
    const f = await fixture(t);
    const a = await f.newThread("/explain the edit");
    await f.send(a);
    const run = f.runId();
    const wave = await f.delivery.parallel.take(run);
    const [job] = wave.jobs;
    assert.equal((await f.delivery.parallel.finish(run, job.jobId, proposed)).outcome, "blocked");
    assert.equal(await f.read("a.txt"), "user uncommitted");
    const waiting = await f.newThread("Another question");
    await f.send(waiting);
    await f.delivery.onIdle();
    const status = (await f.service.findMessage(f.reviewId, waiting.message.messageId)).message.delivery;
    assert.equal(status?.state, "no-reply");
    assert.match(status?.error ?? "", /host worker support/);
    assert.equal(f.sent.length, 2, "the queued comment immediately wakes the current run");
    assert.equal((await f.delivery.deliver(f.reviewId, waiting.thread.threadId, waiting.message.messageId, "parallel-test", { retry: true })).delivered, true);
    assert.equal(f.sent.length, 3);
});
