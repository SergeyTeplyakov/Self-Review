import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SendOptions } from "../src/lib/delivery.mjs";
import type { Review } from "../src/lib/review-service.mjs";
import { host, registerTestHost } from "./provider-host.mjs";

test("a busy canvas delivers a second independent reply while the first worker is still running", { timeout: 60_000 }, async t => {
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "sr-parallel-provider-")));
    const repo = path.join(home, "repo");
    const instanceId = "parallel-provider-test";
    process.env.HOME = process.env.USERPROFILE = home;
    registerTestHost();
    const { loadExtension, runGit } = await import("./modules.mjs");
    try {
        await runGit(home, ["init", "-q", "-b", "main", repo]);
        await runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "base"]);
        await writeFile(path.join(repo, "notes.txt"), "one\ntwo\n");
        await loadExtension();
        const [canvas] = host.canvases;
        const page = new URL((await canvas.open({ instanceId, input: { repoPath: repo, scope: "pending" }, session: { workingDirectory: repo } })).url);
        try {
            async function api<T>(route: string, body?: object): Promise<T> {
                const response = await fetch(new URL(`/api/${route}`, page), {
                    method: body ? "POST" : "GET",
                    headers: { "Content-Type": "application/json", "X-MR-Token": page.searchParams.get("t")! },
                    body: body && JSON.stringify(body), signal: t.signal,
                });
                assert.equal(response.status, 200, `${route} returned ${response.status}`);
                return await response.json() as T;
            }
            const state = () => api<{ review: Review; session: { busy: boolean } }>("state");
            async function invoke<T>(name: string, input: Record<string, unknown>) {
                const action = canvas.actions.find(action => action.name === name);
                assert.ok(action, `provider registered ${name}`);
                return await action.handler({ instanceId, input }) as T;
            }
            async function startComment(body: string) {
                // Subscribe before the HTTP request: delivery can beat the POST response.
                const [[options], comment] = await Promise.all([
                    once(host.events, "send", { signal: AbortSignal.any([t.signal, AbortSignal.timeout(15_000)]) }),
                    api<{ threadId: string; messageId: string }>("threads", { kind: "overview", body }),
                ]);
                const { mode, prompt }: SendOptions = options;
                assert.equal(mode, "immediate", "a busy host must not queue this behind the current turn");
                const runId = /^\[self-review parallel:([^\]]+)\]/.exec(prompt)?.[1];
                assert.ok(runId, "dispatch names the coordinator run");
                host.events.emit("user.message", { data: { content: prompt } });
                const { jobs } = await invoke<{ jobs: { jobId: string; prompt: string }[] }>("take_comment_workers", { runId });
                assert.equal(jobs.length, 1, `a free slot should admit "${body}"`);
                assert.ok(jobs[0].prompt.includes(body));
                return { ...comment, runId, jobId: jobs[0].jobId };
            }
            const finish = ({ runId, jobId }: Awaited<ReturnType<typeof startComment>>, body: string) =>
                invoke("finish_comment_worker", { runId, jobId, outcome: "answered", body });
            function checkThread(review: Review, comment: { threadId: string; messageId: string }, reply?: string) {
                const messages = review.threads.find(thread => thread.threadId === comment.threadId)?.messages;
                assert.ok(messages);
                assert.equal(messages.find(m => m.messageId === comment.messageId)?.delivery?.state, reply ? "replied" : "processing");
                assert.deepEqual(messages.filter(m => m.author === "agent").map(m => [m.inReplyTo, m.body]),
                    reply ? [[comment.messageId, reply]] : []);
            }

            await api("settings", { commentConcurrency: 2, delivery: "immediate" });
            host.events.emit("assistant.turn_start");
            assert.equal((await state()).session.busy, true);
            const first = await startComment("Explain the first line.");
            const second = await startComment("Explain the second line.");
            assert.equal(second.runId, first.runId, "the second submission wakes the same run");
            await finish(second, "The second line is two.");
            const mid = await state();
            checkThread(mid.review, first);
            checkThread(mid.review, second, "The second line is two.");

            await finish(first, "The first line is one.");
            const end = await state();
            checkThread(end.review, first, "The first line is one.");
            checkThread(end.review, second, "The second line is two.");
            assert.deepEqual(await invoke("take_comment_workers", { runId: first.runId }), { done: true, jobs: [] });
        } finally {
            await canvas.onClose({ instanceId });
        }
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
