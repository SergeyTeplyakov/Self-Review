// Delivers user review comments to the agent conversation and tracks their lifecycle:
// saving -> queued -> processing -> replied | no-reply, or failed (retryable).
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { buildBatchPrompt, buildCommentPrompt } from "./prompt.mjs";
import { readCommentImage } from "./comment-images.mjs";
import { resolveDelivery } from "./settings.mjs";
import { ParallelComments } from "./parallel-comments.mjs";
const errorMessage = (error) => String(error && typeof error === "object" && "message" in error ? error.message ?? error : error);
// Also accepts markers written before the rename to Self Review Canvas, so in-flight replies still match.
const MARKER_RE = /^\[(?:self-review sr|manual-review mr):([a-z0-9][a-z0-9._-]{0,100}):(m-[0-9a-f-]{36})\]$/;
const nowIso = () => new Date().toISOString();
export class Delivery extends EventEmitter {
    service;
    send;
    log;
    reviewIds;
    autoSaveLearnedRules;
    sessionId;
    fallbackOwner;
    parallel;
    settings;
    busy;
    bySessionMessageId;
    seenSessionMessageIds;
    touched;
    inFlight;
    sendByAttemptId;
    claimTails;
    lifecycle;
    /**
     * @param {object} p
     * @param {import("./review-service.mjs").ReviewService} p.service
     * @param {(options: object) => Promise<string>} p.send session.send
     * @param {(msg: string, level?: string) => void} p.log
     * @param {() => Iterable<string>} p.reviewIds reviews to settle when the agent goes idle
     * @param {(repoRoot: string) => Promise<boolean>} [p.autoSaveLearnedRules]
     * @param {() => string | undefined} [p.sessionId] conversation that processes the comments this instance sends
     */
    constructor({ service, send, log = () => { }, reviewIds = () => [], autoSaveLearnedRules = async () => false, sessionId = () => undefined, settings }) {
        super();
        this.service = service;
        this.send = send;
        this.log = log;
        this.reviewIds = reviewIds;
        this.autoSaveLearnedRules = autoSaveLearnedRules;
        this.sessionId = sessionId;
        this.fallbackOwner = `delivery-${randomUUID()}`;
        this.settings = settings;
        this.parallel = new ParallelComments(service, send, () => this.owner(), root => this.repoLearning(root));
        this.busy = null;
        this.bySessionMessageId = new Map();
        // Session message ids seen before send() resolved, and whether their turn has already finished.
        this.seenSessionMessageIds = new Map();
        this.touched = new Set();
        this.inFlight = new Map();
        this.sendByAttemptId = new Map();
        this.claimTails = new Map();
        this.lifecycle = Promise.resolve();
    }
    deliver(reviewId, threadId, messageId, instanceId, options = {}) {
        const key = `${reviewId}:${messageId}`;
        const existing = this.inFlight.get(key);
        if (existing)
            return existing;
        const pending = this.deliverOnce(reviewId, threadId, messageId, instanceId, options)
            .finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, pending);
        return pending;
    }
    async deliverOnce(reviewId, threadId, messageId, instanceId, { retry = false } = {}) {
        this.touched.add(reviewId);
        const started = await this.withClaimOrder(reviewId, async () => {
            const claim = await this.service.claimDelivery(reviewId, threadId, messageId, { retry, senderSessionId: this.owner() });
            if (!claim)
                return { result: { delivered: false, skipped: true } };
            return { pending: this.startClaimed(reviewId, [{ threadId, messageId, ...claim }], instanceId, "immediate") };
        });
        return "pending" in started ? started.pending : started.result;
    }
    // Explicit submissions stay together; choosing immediate can release held drafts to parallel workers.
    async submit(reviewId, instanceId, mode = "combined") {
        this.touched.add(reviewId);
        const started = await this.withClaimOrder(reviewId, async () => {
            const claims = await this.service.claimDrafts(reviewId, { senderSessionId: this.owner() });
            if (!claims.length)
                return { result: { submitted: 0, delivered: false } };
            const pending = this.startClaimed(reviewId, claims, instanceId, mode)
                .then((result) => ({ submitted: claims.length, ...result }));
            return { pending };
        });
        return "pending" in started ? started.pending : started.result;
    }
    async repoLearning(repoRoot) {
        try {
            return await this.autoSaveLearnedRules(repoRoot);
        }
        catch (err) {
            this.log(`self-review: could not read the learning setting, using off: ${errorMessage(err)}`, "warning");
            return false;
        }
    }
    // Builds and sends the prompt for claimed messages: one comment uses the single-comment prompt, more use the batch prompt.
    async sendClaimed(reviewId, claims, instanceId, mode) {
        let sessionMessageId;
        try {
            let review = await this.service.getReview(reviewId);
            let predecessors = this.pendingSerialPredecessors(review, claims);
            const savingAttempts = predecessors.filter((predecessor) => predecessor.state === "saving");
            if (savingAttempts.length) {
                const pending = savingAttempts
                    .map((predecessor) => predecessor.attemptId ? this.sendByAttemptId.get(predecessor.attemptId) : undefined)
                    .filter((send) => send !== undefined);
                if (pending.length !== savingAttempts.length) {
                    throw new Error("An earlier comment in this thread is still being queued; retry after it settles.");
                }
                await Promise.all(new Set(pending));
                review = await this.service.getReview(reviewId);
                predecessors = this.pendingSerialPredecessors(review, claims);
                if (predecessors.some((predecessor) => predecessor.state === "saving")) {
                    throw new Error("An earlier comment in this thread is still being queued; retry after it settles.");
                }
            }
            if (mode === "immediate" && this.settings && !predecessors.length) {
                const settings = await this.settings.get(review.repoRoot);
                const limit = settings.commentConcurrency ?? 1;
                if (limit > 1 && resolveDelivery(settings.delivery, review) === "immediate") {
                    return await this.parallel.enqueue(reviewId, instanceId, claims, limit);
                }
            }
            const threadIds = [...new Set(claims.map((c) => c.threadId))];
            const contexts = [];
            for (const threadId of threadIds)
                contexts.push(await this.service.promptContext(reviewId, threadId));
            const autoSaveLearnedRules = await this.repoLearning(contexts[0].review.repoRoot);
            const attachments = [];
            for (const claim of claims) {
                const message = contexts.find((ctx) => ctx.thread.threadId === claim.threadId)?.thread.messages.find((m) => m.messageId === claim.messageId);
                for (const [index, id] of (message?.imageIds ?? []).entries()) {
                    const { bytes, mimeType } = await readCommentImage(this.service.store, reviewId, id);
                    attachments.push({ type: "blob", data: bytes.toString("base64"), mimeType, displayName: `${claim.messageId}-image-${index + 1}` });
                }
            }
            let built;
            if (claims.length === 1) {
                const ctx = contexts[0];
                const message = ctx.thread.messages.find((m) => m.messageId === claims[0].messageId);
                if (!message)
                    throw new Error(`Claimed message ${claims[0].messageId} not found.`);
                built = buildCommentPrompt({ ...ctx, message, instanceId, autoSaveLearnedRules });
            }
            else {
                const ids = new Set(claims.map((c) => c.messageId));
                const groups = contexts.map((ctx) => ({
                    thread: ctx.thread,
                    messages: ctx.thread.messages.filter((m) => ids.has(m.messageId)),
                    excerpt: ctx.excerpt,
                    selected: ctx.selected,
                }));
                built = buildBatchPrompt({ review: contexts[contexts.length - 1].review, groups, instanceId, autoSaveLearnedRules });
            }
            sessionMessageId = await this.send({ prompt: built.prompt, displayPrompt: built.displayPrompt, mode: "enqueue",
                ...(attachments.length ? { attachments } : {}) });
        }
        catch (err) {
            const error = errorMessage(err);
            this.log(`self-review: failed to deliver ${claims.map((c) => c.messageId).join(", ")}: ${error}`, "warning");
            for (const c of claims)
                await this.service.setDelivery(reviewId, c.messageId, { state: "failed", error }, c);
            return { delivered: false, error };
        }
        const targets = claims.map((c) => ({ reviewId, messageId: c.messageId, attemptId: c.attemptId }));
        if (sessionMessageId)
            this.bySessionMessageId.set(sessionMessageId, targets);
        for (const c of claims) {
            await this.service.setDelivery(reviewId, c.messageId, {
                state: "queued",
                sessionMessageId: sessionMessageId ?? null,
                queuedAt: nowIso(),
                error: null,
            }, c);
        }
        // The user.message event can arrive before send() resolves, and its turn may already have finished.
        await this.enqueueLifecycle(async () => {
            const seen = sessionMessageId ? this.seenSessionMessageIds.get(sessionMessageId) : undefined;
            if (!seen)
                return;
            this.seenSessionMessageIds.delete(sessionMessageId);
            for (const target of targets)
                await this.processTarget(target, sessionMessageId, seen.finished);
        });
        return { delivered: true, sessionMessageId };
    }
    withClaimOrder(reviewId, operation) {
        const previous = this.claimTails.get(reviewId) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => gate);
        this.claimTails.set(reviewId, tail);
        return previous.then(operation).finally(() => {
            release();
            if (this.claimTails.get(reviewId) === tail)
                this.claimTails.delete(reviewId);
        });
    }
    startClaimed(reviewId, claims, instanceId, mode) {
        const pending = this.sendClaimed(reviewId, claims, instanceId, mode);
        for (const claim of claims)
            this.sendByAttemptId.set(claim.attemptId, pending);
        const clear = () => {
            for (const claim of claims) {
                if (this.sendByAttemptId.get(claim.attemptId) === pending)
                    this.sendByAttemptId.delete(claim.attemptId);
            }
        };
        void pending.then(clear, clear);
        return pending;
    }
    pendingSerialPredecessors(review, claims) {
        const submitted = new Set(claims.map((claim) => claim.messageId));
        const predecessors = new Map();
        for (const claim of claims) {
            const thread = review.threads.find((entry) => entry.threadId === claim.threadId);
            const index = thread?.messages.findIndex((message) => message.messageId === claim.messageId) ?? -1;
            if (!thread || index <= 0)
                continue;
            for (const message of thread.messages.slice(0, index)) {
                const delivery = message.delivery;
                if (message.author !== "user" || submitted.has(message.messageId) || !delivery?.attemptId || delivery.parallel
                    || !["saving", "queued", "processing"].includes(delivery.state))
                    continue;
                predecessors.set(delivery.attemptId ?? message.messageId, { attemptId: delivery.attemptId, state: delivery.state });
            }
        }
        return [...predecessors.values()];
    }
    // Several conversations can share a review, so a processing comment records which one is working on it.
    owner() {
        return this.sessionId() || this.fallbackOwner;
    }
    // The returned promise reports errors to the caller; a failed event must not block later events.
    enqueueLifecycle(callback) {
        const pending = this.lifecycle.then(callback);
        this.lifecycle = pending.catch(() => { });
        return pending;
    }
    processTarget(target, sessionMessageId, finished = false) {
        return this.service.processDelivery(target.reviewId, target.messageId, {
            attemptId: target.attemptId, sessionMessageId, sessionId: this.owner(), finished,
        });
    }
    onUserMessage(event) {
        this.parallel.onUserMessage(event);
        return this.enqueueLifecycle(() => this.handleUserMessage(event));
    }
    async handleUserMessage(event) {
        const data = event?.data ?? {};
        let targets = data.messageId ? this.bySessionMessageId.get(data.messageId) : undefined;
        if (!targets) {
            const seen = new Set();
            targets = [];
            for (const text of [data.transformedContent, data.content]) {
                for (const line of String(text ?? "").split(/\r?\n/)) {
                    const m = MARKER_RE.exec(line);
                    if (!m)
                        break;
                    if (seen.has(m[2]))
                        continue;
                    seen.add(m[2]);
                    targets.push({ reviewId: m[1], messageId: m[2] });
                }
            }
        }
        let applied = false;
        for (const target of targets) {
            if (await this.processTarget(target, data.messageId)) {
                this.touched.add(target.reviewId);
                applied = true;
            }
        }
        if (!applied) {
            if (data.messageId) {
                this.seenSessionMessageIds.set(data.messageId, { finished: false });
                const oldest = this.seenSessionMessageIds.keys().next();
                if (this.seenSessionMessageIds.size > 200 && !oldest.done)
                    this.seenSessionMessageIds.delete(oldest.value);
            }
            return;
        }
    }
    setBusy(busy) {
        if (this.busy === busy)
            return;
        this.busy = busy;
        this.emit("session", { busy });
    }
    onIdle() {
        return this.enqueueLifecycle(() => this.handleIdle());
    }
    async handleIdle() {
        await this.parallel.onIdle();
        this.setBusy(false);
        for (const seen of this.seenSessionMessageIds.values())
            seen.finished = true;
        const ids = new Set([...this.touched, ...this.reviewIds()]);
        for (const reviewId of ids) {
            try {
                await this.service.settleProcessing(reviewId, { sessionId: this.owner() });
                await this.service.recoverAbandonedClaims(reviewId);
            }
            catch (err) {
                this.log(`self-review: settle failed for ${reviewId}: ${errorMessage(err)}`, "warning");
            }
        }
    }
}
