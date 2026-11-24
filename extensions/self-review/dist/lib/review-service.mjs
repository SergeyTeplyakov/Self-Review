// Review lifecycle: snapshots/revisions, threads, messages, delivery state, lessons.
// Pure persistence + domain logic; agent delivery and HTTP live elsewhere.
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as gitDefault from "./git.mjs";
import { relocate } from "./anchors.mjs";
import { hunkExcerpt, selectedLines } from "./diff.mjs";
import { ReviewError, isRecord, settingsPatch } from "../web/contracts.mjs";
import { parseReviewCommand } from "../web/review-commands.mjs";
import { checkBatchImageBudget, commentImageIds } from "./comment-images.mjs";
import { inferRuleDestination, previewRepositoryRuleDestination, saveRepositoryRule } from "./learned-rules.mjs";
import { pathKey, selectInstructionMapping, validateMappingPrefixes } from "./settings.mjs";
import { readGitBlob } from "./git-process.mjs";
import { DIFF_IMAGE_TYPES, diffImageType, MAX_IMAGE_BYTES } from "./image-format.mjs";
export { ReviewError } from "../web/contracts.mjs";
const errorMessage = (error) => String(error && typeof error === "object" && "message" in error ? error.message ?? error : error);
export const THREAD_KINDS = ["overview", "file", "change", "line"];
export const THREAD_STATUSES = ["active", "resolved", "wontfix", "closed"];
export const OUTCOMES = ["answered", "changed", "blocked", "disagreed", "needs-input"];
export const LESSON_STATUSES = ["proposed", "declined"];
const RULE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/;
export const SCOPES = ["all", "pending"];
const PENDING_SUFFIX = " (pending changes)";
const MAX_BODY = 20000;
const MAX_RANGE = 2000;
const MAX_ANCHOR_LINES = 400;
const MAX_FULL_FILE_LINES = 20000;
const invalid = (msg) => new ReviewError("invalid_input", msg);
const notFound = (msg) => new ReviewError("not_found", msg);
function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}
// "all" reviews the whole branch or PR (working tree vs merge-base); "pending" reviews only uncommitted work (working tree vs HEAD).
export function checkScope(value) {
    if (value == null)
        return "all";
    if (value !== "all" && value !== "pending")
        throw invalid(`scope must be one of ${SCOPES.join(", ")}.`);
    return value;
}
// Reviews saved before scopes existed have no scope field and are "all" reviews.
export function scopeOf(review) {
    return review?.scope === "pending" ? "pending" : "all";
}
// Historical single-commit reviews were removed; their records stay on disk but are never reopened as All or Pending reviews.
export function isRetiredCommitReview(review) {
    return review?.scope === "commit";
}
export function retiredCommitError(review) {
    return new ReviewError("unsupported", `Review ${review.reviewId} is a historical single-commit review. That mode was removed; its local notes remain stored but it can no longer be opened. Open an All changes or Pending changes review instead.`);
}
// The "all" id must stay identical to the pre-scope computation so existing reviews keep their threads.
export function computeReviewId({ repoRoot, branch, base, paths = [], exclude = [], scope = "all" }) {
    const parts = [path.resolve(repoRoot).toLowerCase(), branch, base, [...paths].sort().join(","), [...exclude].sort().join(",")];
    if (scope === "pending")
        parts.push("pending");
    const hash = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
    const label = scope === "pending" ? `${path.basename(repoRoot)}-${branch}-pending` : `${path.basename(repoRoot)}-${branch}-vs-${base}`;
    const readable = slug(label).slice(0, 80) || "review";
    return `${readable}-${hash}`;
}
function defaultTitle({ branch, base, scope }) {
    return scope === "pending" ? `${branch}${PENDING_SUFFIX}` : `${branch} vs ${base}`;
}
function applyOpenOptions(review, input) {
    if (input.title)
        review.title = input.title;
    if (input.includeUntracked !== undefined)
        review.includeUntracked = input.includeUntracked;
    if (input.context !== undefined)
        review.contextLines = input.context;
    return review;
}
// A default title is regenerated for the target scope; a custom title is carried over with the pending suffix toggled.
function siblingTitle(source, targetScope) {
    const origin = source.originBranch ?? source.branch;
    if (source.title === defaultTitle({ branch: origin, base: source.base, scope: scopeOf(source) })) {
        return defaultTitle({ branch: source.branch, base: source.base, scope: targetScope });
    }
    const hasSuffix = source.title.endsWith(PENDING_SUFFIX);
    if (targetScope === "pending")
        return hasSuffix ? source.title : `${source.title}${PENDING_SUFFIX}`;
    return hasSuffix ? source.title.slice(0, -PENDING_SUFFIX.length) : source.title;
}
// originBranch is the branch the id was computed from; branch is the live label refreshed on every capture.
function newReviewRecord({ reviewId, title, repoRoot, base, paths, exclude, includeUntracked, contextLines, branch, originBranch = branch, scope }) {
    return {
        schema: 1,
        reviewId,
        title,
        repoRoot,
        base,
        paths,
        exclude,
        includeUntracked,
        contextLines,
        branch,
        originBranch,
        scope,
        git: null,
        currentRevisionId: null,
        revisions: [],
        threads: [],
        lessons: [],
        createdAt: nowIso(),
    };
}
function nowIso() {
    return new Date().toISOString();
}
function checkBody(body, hasImages = false) {
    if (typeof body !== "string" || (!body.trim() && !hasImages))
        throw invalid("Enter a comment or attach an image.");
    if (body.length > MAX_BODY)
        throw invalid(`Comment body exceeds ${MAX_BODY} characters.`);
    return body.trim();
}
function optionalString(value, name) {
    if (value == null)
        return undefined;
    if (typeof value !== "string")
        throw invalid(`${name} must be a string.`);
    return value;
}
function lessonInput(value) {
    if (!isRecord(value))
        throw invalid("Each lesson needs a non-empty rule or the lessonId of an existing guideline.");
    const fields = value;
    const hasRule = typeof fields.rule === "string" && fields.rule.trim();
    if (!hasRule && !fields.lessonId)
        throw invalid("Each lesson needs a non-empty rule or the lessonId of an existing guideline.");
    if (fields.rule !== undefined && (!hasRule || typeof fields.rule !== "string" || RULE_CONTROL_CHARACTERS.test(fields.rule) || fields.rule.length > 2000)) {
        throw invalid("A guideline must be one non-empty line of at most 2,000 characters.");
    }
    if (fields.savedTo !== undefined)
        throw invalid("Self-Review saves guidelines; do not supply lesson.savedTo.");
    if (fields.scope && fields.scope !== "repo" && fields.scope !== "personal")
        throw invalid("lesson.scope must be repo or personal.");
    if (fields.status != null && (typeof fields.status !== "string" || !LESSON_STATUSES.includes(fields.status))) {
        throw invalid(`lesson.status must be one of ${LESSON_STATUSES.join(", ")}.`);
    }
    let destination;
    if (fields.destination !== undefined) {
        if (!isRecord(fields.destination) || (fields.destination.kind !== "general" && fields.destination.kind !== "language")) {
            throw invalid("lesson.destination must identify a general or language-specific instruction.");
        }
        destination = fields.destination.kind === "general"
            ? {
                kind: "general",
                ...(typeof fields.destination.pathPrefix === "string" ? { pathPrefix: fields.destination.pathPrefix } : {}),
                ...(typeof fields.destination.instructionRoot === "string" ? { instructionRoot: fields.destination.instructionRoot } : {}),
            }
            : {
                kind: "language",
                ...(typeof fields.destination.language === "string" ? { language: fields.destination.language } : {}),
                ...(typeof fields.destination.applyTo === "string" ? { applyTo: fields.destination.applyTo } : {}),
                ...(typeof fields.destination.pathPrefix === "string" ? { pathPrefix: fields.destination.pathPrefix } : {}),
                ...(typeof fields.destination.instructionRoot === "string" ? { instructionRoot: fields.destination.instructionRoot } : {}),
            };
    }
    return {
        lessonId: optionalString(fields.lessonId, "lesson.lessonId"),
        sourceMessageId: optionalString(fields.sourceMessageId, "lesson.sourceMessageId"),
        rule: typeof fields.rule === "string" ? fields.rule : undefined,
        scope: optionalString(fields.scope, "lesson.scope"),
        status: optionalString(fields.status, "lesson.status"),
        destination,
    };
}
function checkLine(value, name) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
        throw invalid(`${name} must be a positive integer.`);
}
function allMessages(review) {
    return review.threads.flatMap((t) => t.messages.map((m) => ({ thread: t, message: m })));
}
function findDuplicate(review, clientRequestId) {
    if (!clientRequestId)
        return null;
    return allMessages(review).find((e) => e.message.clientRequestId === clientRequestId) ?? null;
}
function findThread(review, threadId) {
    const thread = review.threads.find((t) => t.threadId === threadId);
    if (!thread)
        throw notFound(`Thread ${threadId} not found in review ${review.reviewId}.`);
    return thread;
}
// Threads a merged pull request moved to history. They keep their status but no longer count as active work.
export function archivedThreadIds(review) {
    return new Set(review.completions?.flatMap((c) => c.archivedThreadIds) ?? []);
}
// Checked inside each mutation's store update, so neither a canvas action nor a merge recorded mid-request can change history.
export function assertNotArchived(review, threadId) {
    if (archivedThreadIds(review).has(threadId)) {
        throw new ReviewError("conflict", "This thread moved to review history when its pull request merged. Use Start follow-up to continue it.");
    }
}
// Archived threads cannot be claimed, so a comment handed to the transport (or mid-send) was dispatched before the merge.
function wasDispatched(delivery) {
    return ["queued", "processing", "no-reply"].includes(delivery.state) || (delivery.state === "saving" && Boolean(delivery.attemptId));
}
const DISPOSITIONS = { active: "unresolved", resolved: "resolved", wontfix: "won't fix", closed: "closed" };
function followUpBody(thread, pullRequest) {
    const first = thread.messages[0]?.body ?? "";
    const quoted = (first.length > 2000 ? `${first.slice(0, 2000)}...` : first).split("\n").map((line) => `> ${line}`).join("\n");
    const where = thread.kind === "overview" ? "overall comment" : `comment on ${thread.location?.path ?? thread.anchor?.path ?? "a file"}`;
    const source = pullRequest ? `[PR #${pullRequest.number}](${pullRequest.url})` : "an earlier pull request";
    return `Follow-up on a ${where} delivered in ${source}, left ${DISPOSITIONS[thread.status] ?? thread.status} (thread ${thread.threadId}):\n\n${quoted}`;
}
const normalizeRule = (rule) => rule.toLowerCase().replace(/\s+/g, " ").replace(/[\s.;:!,]+$/, "").trim();
function reviewedPathForLesson(review, lesson) {
    if (lesson.reviewedPath !== undefined)
        return lesson.reviewedPath;
    const thread = review.threads.find((item) => item.threadId === lesson.threadId);
    if (thread?.kind === "overview")
        return "";
    return thread?.location?.path ?? thread?.anchor?.path;
}
function destinationFromInput(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!isRecord(value) || (value.kind !== "general" && value.kind !== "language")) {
        throw invalid("Provide a general or language-specific destination.");
    }
    return value.kind === "general" ? { kind: "general" } : {
        kind: "language",
        ...(typeof value.language === "string" ? { language: value.language } : {}),
        ...(typeof value.applyTo === "string" ? { applyTo: value.applyTo } : {}),
    };
}
function mappingsWithConfirmedChoice(mappings, value, reviewedPath) {
    let next = mappings;
    let confirmed;
    if (value !== undefined) {
        const selected = settingsPatch({ instructionMappings: [value] }).instructionMappings?.[0];
        if (!selected)
            throw invalid("Provide one valid instruction mapping.");
        confirmed = selected;
        next = mappings.filter((item) => pathKey(item.pathPrefix) !== pathKey(selected.pathPrefix));
        next.push(selected);
        // Validate the list that will be stored before any rule is written, e.g. the mapping count limit.
        next = settingsPatch({ instructionMappings: next }).instructionMappings;
        validateMappingPrefixes(next);
    }
    const mapping = selectInstructionMapping(next, reviewedPath);
    if (!mapping)
        throw invalid("Choose an instruction destination before saving this repository guideline.");
    if (confirmed) {
        if (mapping.pathPrefix !== confirmed.pathPrefix
            || mapping.instructionRoot !== confirmed.instructionRoot
            || mapping.splitLanguageSpecific !== confirmed.splitLanguageSpecific) {
            throw invalid("The confirmed instruction mapping is shadowed by a more-specific mapping for this file.");
        }
    }
    return { mappings: next, mapping };
}
function sameMapping(a, b) {
    return a?.pathPrefix === b?.pathPrefix && a?.instructionRoot === b?.instructionRoot
        && a?.splitLanguageSpecific === b?.splitLanguageSpecific;
}
async function saveRule(store, repoRoot, lesson, settings, confirmedNewFile = false, expectedSavedTo, confirmedMapping) {
    const personal = lesson.scope === "personal";
    if ((!personal && lesson.scope !== "repo") || !lesson.rule.trim() || RULE_CONTROL_CHARACTERS.test(lesson.rule)) {
        throw invalid("The guideline needs a valid scope and single-line rule.");
    }
    if (!personal) {
        const reviewedPath = lesson.reviewedPath;
        const saveWithMapping = async (mapping) => {
            if (reviewedPath === undefined || !mapping) {
                lesson.saveError = "Choose an instruction destination before saving this repository guideline.";
                return false;
            }
            const destination = lesson.destination ?? inferRuleDestination(reviewedPath);
            const result = await saveRepositoryRule(repoRoot, mapping, reviewedPath, destination, lesson.rule, confirmedNewFile, (key, action) => store.lock(key, action), expectedSavedTo);
            if (result.needsConfirmation) {
                lesson.saveError = `Confirm creating ${result.savedTo} before saving this guideline.`;
                return false;
            }
            lesson.status = "saved";
            lesson.savedTo = result.savedTo;
            lesson.updatedAt = nowIso();
            delete lesson.saveError;
            return true;
        };
        if (confirmedMapping || !settings || reviewedPath === undefined)
            return saveWithMapping(confirmedMapping);
        return settings.withInstructionMappings(repoRoot, (mappings) => saveWithMapping(selectInstructionMapping(mappings, reviewedPath)));
    }
    const root = await realpath(os.homedir());
    const folder = path.join(root, ".copilot");
    const file = path.join(folder, "copilot-instructions.md");
    const containsRule = (text) => text.split(/\r?\n/).some((line) => line.trim().replace(/^(?:[-*+]|\d+\.)\s+/, "") === lesson.rule);
    await store.lock(`guideline-file:${file}`, async () => {
        await mkdir(folder, { recursive: true });
        if ((await lstat(folder)).isSymbolicLink() || path.relative(root, await realpath(folder)) !== path.basename(folder)) {
            throw invalid("The instruction directory must not redirect to another location.");
        }
        let contents;
        try {
            if (!(await lstat(file)).isFile())
                throw invalid("The instruction destination is not a regular file.");
            contents = await readFile(file, "utf8");
        }
        catch (error) {
            if (!isRecord(error) || error.code !== "ENOENT")
                throw error;
            contents = "";
        }
        if (!containsRule(contents)) {
            const newline = contents.includes("\r\n") ? "\r\n" : "\n";
            await appendFile(file, `${contents ? (contents.endsWith("\n") ? newline : newline + newline) : ""}- ${lesson.rule}${newline}`, "utf8");
        }
        if (!containsRule(await readFile(file, "utf8")))
            throw new ReviewError("conflict", "Could not verify the saved guideline.");
    });
    lesson.status = "saved";
    lesson.savedTo = file;
    lesson.updatedAt = nowIso();
    delete lesson.saveError;
    return true;
}
// Update a proposal in place so discussion retains its link to the originating comment.
function applyLesson(review, { reviewId, threadId, messageId, reviewedPath }, input) {
    const status = input.status ?? "proposed";
    const rule = typeof input.rule === "string" ? input.rule.trim() : "";
    let lesson;
    if (input.lessonId) {
        lesson = review.lessons.find((l) => l.lessonId === input.lessonId && l.threadId === threadId);
        if (!lesson)
            throw notFound(`Lesson ${input.lessonId} not found in thread ${threadId}.`);
    }
    else {
        lesson = review.lessons.find((l) => l.threadId === threadId && (l.status ?? "saved") === "proposed"
            && (!input.sourceMessageId || l.sourceMessageId === input.sourceMessageId) && normalizeRule(l.rule) === normalizeRule(rule));
    }
    const sourceMessageId = lesson?.sourceMessageId ?? input.sourceMessageId;
    if (lesson?.sourceMessageId && input.sourceMessageId && lesson.sourceMessageId !== input.sourceMessageId) {
        throw invalid("A lesson cannot be reassigned to a different originating comment.");
    }
    if (lesson && lesson.status !== "proposed")
        throw new ReviewError("conflict", "Only a proposed guideline can be updated.");
    if (!lesson) {
        lesson = {
            lessonId: `l-${randomUUID().slice(0, 8)}`,
            reviewId,
            threadId,
            messageId,
            ...(sourceMessageId ? { sourceMessageId } : {}),
            scope: input.scope ?? "repo",
            rule,
            ...(reviewedPath !== undefined ? { reviewedPath, destination: input.destination ?? inferRuleDestination(reviewedPath) } : {}),
            status,
            savedTo: null,
            createdAt: nowIso(),
        };
        review.lessons.push(lesson);
        return lesson;
    }
    if (rule)
        lesson.rule = rule;
    if (sourceMessageId)
        lesson.sourceMessageId = sourceMessageId;
    if (input.scope)
        lesson.scope = input.scope;
    if (reviewedPath !== undefined) {
        lesson.reviewedPath = reviewedPath;
        if (input.destination)
            lesson.destination = input.destination;
        else
            lesson.destination ??= inferRuleDestination(reviewedPath);
    }
    lesson.status = status;
    lesson.savedTo = null;
    delete lesson.saveError;
    lesson.updatedAt = nowIso();
    return lesson;
}
function revisionContent(file, oldLines) {
    let oldIndex = 0;
    const lines = [];
    for (const hunk of file.hunks) {
        const oldStart = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
        const newStart = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
        if (oldStart < oldIndex || oldStart > oldLines.length || newStart - lines.length !== oldStart - oldIndex)
            return null;
        while (oldIndex < oldStart) {
            lines.push(oldLines[oldIndex++]);
        }
        for (const row of hunk.rows) {
            if (row.o != null) {
                if (row.o !== oldIndex + 1 || oldLines[oldIndex] !== row.s)
                    return null;
                oldIndex++;
            }
            if (row.n != null) {
                if (row.n !== lines.length + 1)
                    return null;
                lines.push(row.s);
            }
        }
        if (oldIndex !== oldStart + hunk.oldLines || lines.length !== newStart + hunk.newLines)
            return null;
    }
    return lines.concat(oldLines.slice(oldIndex));
}
function matchesRevision(file, oldLines, newLines) {
    const lines = revisionContent(file, oldLines);
    return lines !== null && lines.length === newLines.length && lines.every((line, i) => line === newLines[i]);
}
// A draft is held by the reviewer and has not been offered to the agent yet.
const DELIVERY_RANK = { draft: -1, saving: 0, failed: 1, queued: 2, processing: 3, "no-reply": 4, replied: 5 };
const REVIEW_DELIVERY_CHOICES = ["immediate", "batch"];
// Signal 0 only probes the process; EPERM means it exists but belongs to another user.
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err instanceof Error && "code" in err && err.code === "EPERM";
    }
}
export class ReviewService extends EventEmitter {
    store;
    git;
    log;
    pid;
    isProcessAlive;
    refreshes;
    refreshErrors = new Map();
    /**
     * @param {object} p
     * @param {number} [p.pid] process recorded on delivery claims
     * @param {(pid: number) => boolean} [p.isProcessAlive] whether a claiming process is still running
     */
    constructor({ store, settings, git = gitDefault, log = () => { }, pid = process.pid, isProcessAlive = processAlive, autoSaveLearnedRules = async () => false }) {
        super();
        this.store = store;
        this.settings = settings;
        this.git = git;
        this.log = log;
        this.pid = pid;
        this.isProcessAlive = isProcessAlive;
        this.autoSaveLearnedRules = autoSaveLearnedRules;
        this.refreshes = new Map();
    }
    autoSaveLearnedRules;
    settings;
    changed(reviewId, reason) {
        this.emit("changed", { reviewId, reason });
    }
    async getReview(reviewId) {
        const review = await this.store.readReview(reviewId);
        if (!review)
            throw notFound(`Review ${reviewId} not found.`);
        return review;
    }
    async updateDescription(reviewId, { body, expectedVersion }) {
        const text = checkBody(body);
        if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 0)
            throw invalid("expectedVersion must be a non-negative integer.");
        const description = await this.store.updateReview(reviewId, (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review))
                throw retiredCommitError(review);
            const current = review.description;
            if ((current?.version ?? 0) !== expectedVersion) {
                throw new ReviewError("conflict", "Description changed. Read the current description before revising it.");
            }
            if (current?.body === text)
                return { write: false, value: current };
            review.description = { body: text, version: expectedVersion + 1, revisionId: review.currentRevisionId, updatedAt: nowIso() };
            return { review, value: review.description };
        });
        this.changed(reviewId, "description");
        return description;
    }
    descriptionContext(review, input) {
        if (input.descriptionVersion !== undefined && input.descriptionVersion !== (review.description?.version ?? 0)) {
            throw new ReviewError("conflict", "Description changed since you read it. Refresh and review it before posting.");
        }
        return review.description ? { ...review.description } : null;
    }
    // Creates the review on first open, then captures a fresh snapshot.
    // An explicit scope that differs from an existing review's scope opens its sibling review instead.
    async ensureReview(input = {}, { cwd = process.cwd() } = {}) {
        const requestedScope = input.scope == null ? null : checkScope(input.scope);
        if (input.reviewId) {
            const existing = await this.getReview(input.reviewId);
            if (isRetiredCommitReview(existing))
                throw retiredCommitError(existing);
            const switching = requestedScope !== null && requestedScope !== scopeOf(existing);
            const reviewId = switching ? await this.openSibling(input.reviewId, requestedScope, { base: input.base }) : input.reviewId;
            const hasOptions = input.title || input.includeUntracked !== undefined || input.context !== undefined;
            if (hasOptions) {
                await this.store.updateReview(reviewId, (r) => {
                    if (!r)
                        throw notFound(`Review ${reviewId} not found.`);
                    return { review: applyOpenOptions(r, input) };
                });
            }
            if (!switching || hasOptions)
                await this.refresh(reviewId);
            return reviewId;
        }
        let repoRoot;
        try {
            repoRoot = await this.git.resolveRepoRoot(input.repoPath || cwd);
        }
        catch (err) {
            throw invalid(`Not a git repository: ${input.repoPath || cwd} (${errorMessage(err)})`);
        }
        const scope = requestedScope ?? "all";
        const base = input.base || (scope === "pending" ? null : await this.git.defaultBase(repoRoot));
        const branch = (await this.git.runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
        const paths = input.paths ?? [];
        const exclude = input.exclude ?? [];
        const reviewId = computeReviewId({ repoRoot, branch, base, paths, exclude, scope });
        await this.store.updateReview(reviewId, (existing) => {
            if (existing) {
                return { review: applyOpenOptions(existing, input) };
            }
            return {
                review: newReviewRecord({
                    reviewId,
                    title: input.title || defaultTitle({ branch, base, scope }),
                    repoRoot,
                    base,
                    paths,
                    exclude,
                    includeUntracked: input.includeUntracked ?? true,
                    contextLines: input.context ?? 5,
                    branch,
                    scope,
                }),
            };
        });
        await this.refresh(reviewId);
        return reviewId;
    }
    // Opens the other-scope review of the same repository, branch, base, and pathspecs, creating it on first use.
    async openSibling(reviewId, scope, { base: requestedBase } = {}) {
        const target = checkScope(scope);
        const source = await this.getReview(reviewId);
        if (isRetiredCommitReview(source))
            throw retiredCommitError(source);
        if (target === scopeOf(source))
            return reviewId;
        if (source.siblingReviewId && !requestedBase) {
            await this.refresh(source.siblingReviewId);
            return source.siblingReviewId;
        }
        const base = requestedBase || source.base || (target === "all" ? await this.git.defaultBase(source.repoRoot) : null);
        const originBranch = source.originBranch ?? source.branch;
        const siblingId = computeReviewId({
            repoRoot: source.repoRoot,
            branch: originBranch,
            base,
            paths: source.paths,
            exclude: source.exclude,
            scope: target,
        });
        await this.store.updateReview(siblingId, (existing) => {
            if (existing)
                return { review: Object.assign(existing, { siblingReviewId: reviewId }) };
            return {
                review: { ...newReviewRecord({
                        reviewId: siblingId,
                        title: siblingTitle({ ...source, base }, target),
                        repoRoot: source.repoRoot,
                        base,
                        paths: source.paths,
                        exclude: source.exclude,
                        includeUntracked: source.includeUntracked,
                        contextLines: source.contextLines,
                        branch: source.branch,
                        originBranch,
                        scope: target,
                    }), siblingReviewId: reviewId },
            };
        });
        await this.refresh(siblingId);
        await this.store.updateReview(reviewId, (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            return { review: Object.assign(review, { siblingReviewId: siblingId }) };
        });
        return siblingId;
    }
    refreshState(reviewId) {
        if (this.refreshes.has(reviewId))
            return { status: "refreshing" };
        const error = this.refreshErrors.get(reviewId);
        return error === undefined ? { status: "idle" } : { status: "error", error };
    }
    refresh(reviewId, isCurrent) {
        const running = this.refreshes.get(reviewId);
        if (running?.promise) {
            if (isCurrent) {
                const resume = () => isCurrent() ? this.refresh(reviewId, isCurrent) : null;
                return running.promise.then(resume, resume);
            }
            running.again = true;
            return running.promise;
        }
        const entry = { again: false };
        this.refreshes.set(reviewId, entry);
        this.refreshErrors.delete(reviewId);
        entry.promise = (async () => {
            try {
                let result = isCurrent ? await this.captureRevision(reviewId, isCurrent) : await this.refreshOnce(reviewId);
                while (entry.again) {
                    entry.again = false;
                    result = await this.refreshOnce(reviewId);
                }
                return result;
            }
            catch (error) {
                this.refreshErrors.set(reviewId, errorMessage(error));
                throw error;
            }
            finally {
                this.refreshes.delete(reviewId);
                this.changed(reviewId, "refresh");
            }
        })();
        this.changed(reviewId, "refresh");
        return entry.promise;
    }
    refreshOnce(reviewId) {
        return this.captureRevision(reviewId);
    }
    async captureRevision(reviewId, isCurrent) {
        if (isCurrent && !isCurrent())
            return null;
        const before = await this.getReview(reviewId);
        if (isRetiredCommitReview(before))
            throw retiredCommitError(before);
        let snapshot;
        const completion = before.completions?.at(-1);
        try {
            snapshot = await this.git.captureSnapshot({
                repoRoot: before.repoRoot,
                base: before.base,
                paths: before.paths,
                exclude: before.exclude,
                includeUntracked: before.includeUntracked,
                contextLines: before.contextLines,
                scope: scopeOf(before),
                delivered: completion?.pullRequest,
            });
        }
        catch (err) {
            if (isCurrent && !isCurrent())
                return null;
            throw new ReviewError("git_error", errorMessage(err));
        }
        if (isCurrent && !isCurrent())
            return null;
        const result = await this.store.updateReview(reviewId, async (review) => {
            if (isCurrent && !isCurrent())
                return { write: false, value: null };
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            const git = {
                branch: snapshot.branch,
                headCommit: snapshot.headCommit,
                baseCommit: snapshot.baseCommit,
                upstream: snapshot.upstream,
                uncommittedFiles: snapshot.uncommittedFiles.length,
                capturedAt: nowIso(),
                ...(completion && snapshot.delivered
                    ? { delivered: { pullRequestNumber: completion.pullRequest.number, separation: snapshot.delivered } }
                    : {}),
            };
            const latest = review.revisions[review.revisions.length - 1];
            let created = false;
            let revisionId = latest?.revisionId;
            if (!latest || latest.fingerprint !== snapshot.fingerprint) {
                revisionId = `r${review.revisions.length + 1}`;
                const stats = snapshot.files.reduce((a, f) => ({ additions: a.additions + f.additions, deletions: a.deletions + f.deletions }), { additions: 0, deletions: 0 });
                review.revisions.push({
                    revisionId,
                    fingerprint: snapshot.fingerprint,
                    createdAt: nowIso(),
                    headCommit: snapshot.headCommit,
                    baseCommit: snapshot.baseCommit,
                    files: snapshot.files.length,
                    ...stats,
                });
                review.currentRevisionId = revisionId;
                created = true;
            }
            review.git = git;
            review.branch = snapshot.branch;
            const moved = await this.relocateThreads(review, revisionId, snapshot.baseCommit);
            if (isCurrent && !isCurrent())
                return { write: false, value: null };
            if (created)
                await this.store.writeSnapshot(reviewId, revisionId, { revisionId, ...snapshot });
            return {
                review,
                value: { revisionId: revisionId, created, moved },
                publication: isCurrent ? {
                    isCurrent,
                    discardedValue: null,
                    discard: created ? () => this.store.discardSnapshot(reviewId, revisionId) : undefined,
                } : undefined,
            };
        });
        if (!result)
            return null;
        if (result.created || result.moved)
            this.changed(reviewId, "revision");
        else
            this.changed(reviewId, "git");
        return result;
    }
    async relocateThreads(review, revisionId, baseCommit) {
        const cache = new Map();
        const contentFor = async (side, filePath) => {
            const key = `${side}\0${filePath}`;
            if (!cache.has(key)) {
                cache.set(key, side === "old"
                    ? await this.git.readCommitFile(review.repoRoot, baseCommit, filePath)
                    : await this.git.readWorkingFile(review.repoRoot, filePath));
            }
            return cache.get(key);
        };
        let moved = 0;
        for (const thread of review.threads) {
            if (!thread.location || thread.location.revisionId === revisionId)
                continue;
            if (thread.kind === "line" || thread.kind === "change") {
                const side = thread.location.side;
                const lines = await contentFor(side, side === "old" ? (thread.anchor.oldPath ?? thread.anchor.path) : thread.location.path);
                const next = relocate(thread.anchor, thread.location.startLine, lines);
                if (next.startLine !== thread.location.startLine || next.state !== thread.location.state)
                    moved++;
                thread.location = { ...thread.location, ...next, revisionId: revisionId };
            }
            else {
                thread.location = { ...thread.location, revisionId: revisionId };
            }
        }
        return moved;
    }
    async getSnapshot(reviewId, revisionId) {
        const review = await this.getReview(reviewId);
        const rev = revisionId ?? review.currentRevisionId;
        const snapshot = await this.store.readSnapshot(reviewId, rev);
        if (!snapshot)
            throw notFound(`Revision ${rev} not found for review ${reviewId}.`);
        return snapshot;
    }
    async getDiffImage(reviewId, revisionId, filePath, side) {
        if (side !== "old" && side !== "new")
            throw invalid("Expected an old or new image side.");
        const snapshot = await this.getSnapshot(reviewId, revisionId);
        const file = snapshot.files.find((entry) => entry.path === filePath);
        const oid = file?.imageSides?.[side];
        if (!file || !oid)
            throw notFound("No image on this side of the reviewed change.");
        const { repoRoot } = await this.getReview(reviewId);
        let bytes = file.untracked ? null : await readGitBlob(repoRoot, oid, MAX_IMAGE_BYTES);
        // Git computes the worktree blob ID for diff without necessarily storing that blob.
        if (!bytes && side === "new")
            bytes = await this.git.readMatchingWorkingImage(repoRoot, file, oid);
        const type = bytes && diffImageType(bytes);
        if (!bytes || !type)
            throw notFound("Image unavailable in this revision, unsupported, or over 2 MB.");
        return { bytes, mimeType: DIFF_IMAGE_TYPES[type] };
    }
    // Validate gaps against the saved base as well as hunks so newer edits cannot leak into an older revision.
    async getFileContent(reviewId, revisionId, filePath) {
        const review = await this.getReview(reviewId);
        if (typeof filePath !== "string" || !filePath)
            throw invalid("path is required.");
        this.git.safeJoin(review.repoRoot, filePath);
        const rev = revisionId ?? review.currentRevisionId;
        const snapshot = await this.store.readSnapshot(reviewId, rev);
        if (!snapshot)
            throw notFound(`Revision ${rev} not found for review ${reviewId}.`);
        const file = snapshot.files.find((f) => f.path === filePath);
        if (!file)
            throw notFound(`${filePath} is not part of revision ${rev}.`);
        const base = { revisionId: rev, path: filePath };
        if (file.binary)
            return { ...base, available: false, reason: "binary" };
        if (file.status === "deleted")
            return { ...base, available: false, reason: "deleted" };
        const lines = await this.git.readWorkingFile(review.repoRoot, filePath);
        if (!lines)
            return { ...base, available: false, reason: "missing", stale: true };
        const endsWithNewline = lines[lines.length - 1] === "";
        if (lines[lines.length - 1] === "")
            lines.pop();
        const finalRow = file.hunks.flatMap((h) => h.rows).find((r) => r.n === lines.length);
        if (finalRow && Boolean(finalRow.noNewlineAtEnd) === endsWithNewline) {
            return { ...base, available: false, reason: "stale", stale: true };
        }
        if (lines.length > MAX_FULL_FILE_LINES)
            return { ...base, available: false, reason: "too-large" };
        const oldLines = file.status === "added"
            ? []
            : await this.git.readCommitFile(review.repoRoot, snapshot.baseCommit, file.oldPath ?? file.path);
        if (!oldLines)
            return { ...base, available: false, reason: "base-unavailable" };
        if (oldLines[oldLines.length - 1] === "")
            oldLines.pop();
        if (oldLines.length > MAX_FULL_FILE_LINES)
            return { ...base, available: false, reason: "too-large" };
        if (!matchesRevision(file, oldLines, lines))
            return { ...base, available: false, reason: "stale", stale: true };
        return { ...base, available: true, lines };
    }
    async buildAnchor(review, { kind, path: filePath, side, startLine, endLine, revisionId }) {
        if (kind === "overview")
            return { anchor: null, location: null };
        if (typeof filePath !== "string" || !filePath)
            throw invalid("path is required for file, change, and line threads.");
        this.git.safeJoin(review.repoRoot, filePath);
        const rev = revisionId ?? review.currentRevisionId;
        const snapshot = await this.store.readSnapshot(review.reviewId, rev);
        const file = snapshot?.files.find((f) => f.path === filePath) ?? null;
        if (!snapshot)
            throw notFound(`Revision ${rev} not found for review ${review.reviewId}.`);
        if (kind === "file") {
            const base = { revisionId: rev, path: filePath, oldPath: file?.oldPath ?? null };
            return { anchor: base, location: { revisionId: rev, path: filePath, state: "current" } };
        }
        if (!file)
            throw notFound(`${filePath} is not part of revision ${rev}.`);
        const s = side === "old" ? "old" : "new";
        checkLine(startLine, "startLine");
        const end = endLine ?? startLine;
        checkLine(end, "endLine");
        if (end < startLine)
            throw invalid("endLine must be >= startLine.");
        if (end - startLine + 1 > MAX_RANGE)
            throw invalid(`Range exceeds ${MAX_RANGE} lines.`);
        let selected = file ? selectedLines(file, s, startLine, end) : [];
        if (selected.length !== end - startLine + 1) {
            const content = s === "old"
                ? await this.git.readCommitFile(review.repoRoot, snapshot.baseCommit, file.oldPath ?? filePath)
                : await this.revisionLines(review.reviewId, rev, filePath);
            if (!content || end > content.length)
                throw invalid(`Lines ${startLine}-${end} are outside ${filePath} (${s} side).`);
            selected = content.slice(startLine - 1, end);
        }
        const excerpt = file ? hunkExcerpt(file, s, startLine, end) : null;
        const anchor = {
            revisionId: rev,
            path: filePath,
            oldPath: file?.oldPath ?? null,
            side: s,
            startLine,
            endLine: end,
            selectedLines: selected.slice(0, MAX_ANCHOR_LINES),
            hunkHeader: excerpt?.header ?? null,
            hunkText: excerpt?.text ?? null,
        };
        return { anchor, location: { revisionId: rev, path: filePath, side: s, startLine, endLine: end, state: "current" } };
    }
    async buildThread(review, input) {
        if (isRetiredCommitReview(review))
            throw retiredCommitError(review);
        const kind = input.kind ?? "line";
        if (!THREAD_KINDS.includes(kind))
            throw invalid(`kind must be one of ${THREAD_KINDS.join(", ")}.`);
        const author = input.author === "agent" ? "agent" : "user";
        const imageIds = author === "user" ? await commentImageIds(this.store, review.reviewId, input.imageIds) : [];
        const body = checkBody(input.body, imageIds.length > 0);
        const { anchor, location } = await this.buildAnchor(review, { ...input, kind });
        const message = {
            messageId: `m-${randomUUID()}`,
            author,
            body,
            ...(imageIds.length ? { imageIds } : {}),
            createdAt: nowIso(),
            clientRequestId: optionalString(input.clientRequestId, "clientRequestId") ?? null,
            ...(author === "user" ? { delivery: input.hold ? { state: "draft", attempts: 0 } : { state: "saving", attempts: 0, claimPid: this.pid } } : { outcome: optionalString(input.outcome, "outcome") ?? null }),
            ...(kind === "overview" ? { descriptionContext: this.descriptionContext(review, input) } : {}),
        };
        const thread = {
            threadId: `t-${randomUUID().slice(0, 8)}`,
            kind,
            status: "active",
            author,
            createdAt: nowIso(),
            anchor,
            location,
            messages: [message],
        };
        return { thread, message };
    }
    async createThread(reviewId, input) {
        const result = await this.store.updateReview(reviewId, async (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            const dup = findDuplicate(review, input.clientRequestId);
            if (dup)
                return { write: false, value: { thread: dup.thread, message: dup.message, duplicate: true } };
            const { thread, message } = await this.buildThread(review, input);
            review.threads.push(thread);
            if (thread.location && thread.location.revisionId !== review.currentRevisionId) {
                await this.relocateThreads(review, review.currentRevisionId, review.git?.baseCommit);
            }
            return { review, value: { thread, message, duplicate: false } };
        });
        this.changed(reviewId, "thread");
        return result;
    }
    // Records a merged pull request once and moves the threads that existed when it merged into history, keeping
    // their status. The refresh that follows leaves the delivered commits out of the active diff where it can.
    async recordCompletion(reviewId, pullRequest, branch) {
        if (pullRequest.state !== "merged")
            return false;
        const recorded = await this.store.updateReview(reviewId, (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review) || scopeOf(review) !== "all")
                return { write: false, value: false };
            // The lookup used the live branch; a review opened for another branch must not adopt its pull request.
            if (review.branch !== branch || (review.originBranch ?? branch) !== branch)
                return { write: false, value: false };
            if (review.completions?.some((c) => c.pullRequest.number === pullRequest.number))
                return { write: false, value: false };
            const mergedAt = pullRequest.mergedAt;
            const beforeMerge = (at) => !mergedAt || at <= mergedAt;
            const archived = archivedThreadIds(review);
            const delivered = [...review.revisions].reverse().find((r) => beforeMerge(r.createdAt));
            (review.completions ??= []).push({
                pullRequest,
                completedAt: nowIso(),
                archivedThreadIds: review.threads.filter((t) => !archived.has(t.threadId) && beforeMerge(t.createdAt)).map((t) => t.threadId),
                deliveredRevisionId: delivered?.revisionId ?? null,
            });
            return { review, value: true };
        });
        if (!recorded)
            return false;
        this.changed(reviewId, "completion");
        // A failed capture is reported through refreshState; the completion itself is already saved.
        await this.refresh(reviewId).catch(() => null);
        return true;
    }
    // Carries archived threads into new held drafts. The originals are left untouched and nothing is sent.
    async startFollowUp(reviewId, threadIds) {
        if (!Array.isArray(threadIds) || !threadIds.length || !threadIds.every((id) => typeof id === "string")) {
            throw invalid("threadIds must be a non-empty list of thread IDs.");
        }
        const created = await this.store.updateReview(reviewId, async (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review))
                throw retiredCommitError(review);
            const snapshot = review.currentRevisionId ? await this.store.readSnapshot(reviewId, review.currentRevisionId) : null;
            const inDiff = (filePath) => Boolean(filePath && snapshot?.files.some((f) => f.path === filePath));
            const threads = [];
            for (const id of new Set(threadIds)) {
                const completion = review.completions?.find((c) => c.archivedThreadIds.includes(id));
                if (!completion)
                    throw invalid(`Thread ${id} is not in review history.`);
                const original = findThread(review, id);
                const base = { body: followUpBody(original, completion.pullRequest), author: "user", hold: true };
                const loc = original.location;
                const candidates = [];
                if (loc && original.kind !== "overview" && inDiff(loc.path)) {
                    if (loc.state === "current" && loc.revisionId === review.currentRevisionId && original.kind !== "file") {
                        candidates.push({ ...base, kind: original.kind, path: loc.path, side: loc.side, startLine: loc.startLine, endLine: loc.endLine });
                    }
                    candidates.push({ ...base, kind: "file", path: loc.path });
                }
                candidates.push({ ...base, kind: "overview" });
                let built;
                for (const input of candidates) {
                    try {
                        built = await this.buildThread(review, input);
                        break;
                    }
                    catch (error) {
                        if (!(error instanceof ReviewError) || input.kind === "overview")
                            throw error;
                    }
                }
                const thread = { ...built.thread, followUpOf: id };
                review.threads.push(thread);
                threads.push(thread);
            }
            return { review, value: threads };
        });
        this.changed(reviewId, "thread");
        return created;
    }
    async addMessage(reviewId, threadId, input) {
        const author = input.author === "agent" ? "agent" : "user";
        const imageIds = author === "user" ? await commentImageIds(this.store, reviewId, input.imageIds) : [];
        const body = checkBody(input.body, imageIds.length > 0);
        if (author === "agent" && input.outcome && (typeof input.outcome !== "string" || !OUTCOMES.includes(input.outcome))) {
            throw invalid(`outcome must be one of ${OUTCOMES.join(", ")}.`);
        }
        const lessonsInput = Array.isArray(input.lessons) ? input.lessons.map((value) => lessonInput(value)) : [];
        const touchedLessons = new Map();
        const result = await this.store.updateReview(reviewId, async (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review))
                throw retiredCommitError(review);
            const dup = findDuplicate(review, input.clientRequestId);
            if (dup)
                return { write: false, value: { thread: dup.thread, message: dup.message, duplicate: true } };
            const thread = findThread(review, threadId);
            if (author === "user")
                assertNotArchived(review, threadId);
            const message = {
                messageId: `m-${randomUUID()}`,
                author,
                body,
                ...(imageIds.length ? { imageIds } : {}),
                createdAt: nowIso(),
                clientRequestId: optionalString(input.clientRequestId, "clientRequestId") ?? null,
                ...(thread.kind === "overview" && author === "user" ? { descriptionContext: this.descriptionContext(review, input) } : {}),
            };
            if (author === "user") {
                message.delivery = input.hold ? { state: "draft", attempts: 0 } : { state: "saving", attempts: 0, claimPid: this.pid };
                if (thread.status !== "active")
                    thread.status = "active";
            }
            else {
                message.outcome = optionalString(input.outcome, "outcome") ?? null;
                message.verification = optionalString(input.verification, "verification") ?? null;
                message.inReplyTo = optionalString(input.inReplyTo, "inReplyTo") ?? null;
                const target = input.inReplyTo
                    ? thread.messages.find((m) => m.messageId === input.inReplyTo)
                    : [...thread.messages].reverse().find((m) => m.author === "user" && m.delivery && !["replied", "draft"].includes(m.delivery.state));
                if (input.inReplyTo && !target)
                    throw notFound(`Message ${input.inReplyTo} not found in thread ${threadId}.`);
                if (target?.delivery?.state === "draft") {
                    throw new ReviewError("conflict", `Message ${input.inReplyTo} is a draft the reviewer has not sent yet; reply after it is delivered.`);
                }
                // The agent may still answer a comment dispatched before the merge; its work is not lost.
                if (!target?.delivery || !wasDispatched(target.delivery))
                    assertNotArchived(review, threadId);
                if (input.parallelAttemptId && (target?.delivery?.attemptId !== input.parallelAttemptId
                    || !target.delivery.parallel || target.delivery.state !== "processing")) {
                    throw new ReviewError("conflict", "This parallel comment attempt is no longer processing.");
                }
                if (target?.delivery?.parallel && !input.parallelAttemptId && ["queued", "processing"].includes(target.delivery.state)) {
                    throw new ReviewError("conflict", "Use the parallel worker result to reply to this comment.");
                }
                const requestedBatch = optionalString(input.batchId, "batchId");
                const originalBatch = target?.delivery?.submittedBatchId ?? target?.delivery?.batchId;
                if (requestedBatch && (!input.inReplyTo || requestedBatch !== originalBatch)) {
                    throw invalid("batchId must identify the submission that included the reply target.");
                }
                const batchId = input.parallelAttemptId ? undefined : requestedBatch ?? target?.delivery?.batchId;
                const answered = batchId ? thread.messages.filter((m) => m.author === "user" && (m.delivery?.submittedBatchId ?? m.delivery?.batchId) === batchId)
                    : target?.author === "user" ? [target] : [];
                if (target?.delivery) {
                    const repliedAt = nowIso();
                    // One reply answers every comment the same submitted review added to this thread.
                    for (const m of answered) {
                        if (m.delivery && m.delivery.state !== "replied") {
                            m.delivery = { ...m.delivery, state: "replied", repliedAt };
                        }
                    }
                }
                message.lessonIds = [];
                const sourceComment = answered.length === 1 ? answered[0] : undefined;
                const explainOnly = answered.length > 0 && answered.every((m) => parseReviewCommand(m.body)?.name === "explain");
                const needsLearnSource = answered.length > 1 && answered.some((m) => parseReviewCommand(m.body)?.name === "learn");
                for (const l of lessonsInput) {
                    if (explainOnly)
                        throw invalid("/explain cannot record a guideline.");
                    if (!l.lessonId && !l.sourceMessageId && needsLearnSource) {
                        throw invalid("lesson.sourceMessageId is required when the reply answers multiple comments including /learn.");
                    }
                    const source = l.sourceMessageId ? answered.find((m) => m.messageId === l.sourceMessageId) : undefined;
                    if (l.sourceMessageId && (!source?.delivery || source.delivery.state === "draft" || parseReviewCommand(source.body)?.name === "explain")) {
                        throw invalid("lesson.sourceMessageId must identify a delivered learning comment answered by this reply, not /explain.");
                    }
                    const attributed = !l.lessonId && !l.sourceMessageId && sourceComment
                        ? { ...l, sourceMessageId: sourceComment.messageId } : l;
                    const sourceLocation = thread.location ?? thread.anchor;
                    const lesson = applyLesson(review, {
                        reviewId, threadId, messageId: message.messageId,
                        ...(sourceLocation?.path ? { reviewedPath: sourceLocation.path } : thread.kind === "overview" ? { reviewedPath: "" } : {}),
                    }, attributed);
                    if (!message.lessonIds.includes(lesson.lessonId))
                        message.lessonIds.push(lesson.lessonId);
                    touchedLessons.set(lesson.lessonId, lesson);
                }
                let autoSave = false;
                if ([...touchedLessons.values()].some((lesson) => lesson.status === "proposed")) {
                    try {
                        autoSave = await this.autoSaveLearnedRules(review.repoRoot);
                    }
                    catch (error) {
                        this.log(`self-review: could not read the auto-save setting; keeping guidelines proposed: ${errorMessage(error)}`, "warning");
                    }
                }
                if (autoSave) {
                    for (const lesson of touchedLessons.values()) {
                        if (lesson.status !== "proposed")
                            continue;
                        try {
                            await saveRule(this.store, review.repoRoot, lesson, this.settings);
                        }
                        catch (error) {
                            this.log(`self-review: could not auto-save guideline: ${error instanceof Error ? error.message : String(error)}`, "warning");
                            lesson.saveError = "Could not save guideline automatically. It is still a proposal.";
                        }
                    }
                }
            }
            thread.messages.push(message);
            return { review, value: { thread, message, duplicate: false }, journalLessons: touchedLessons.values() };
        });
        this.changed(reviewId, "message");
        return result;
    }
    async saveLesson(reviewId, lessonId, { rule, scope, mapping, destination, expectedSavedTo, expectedInstructionMappings }) {
        if (typeof rule !== "string" || (scope !== "repo" && scope !== "personal"))
            throw invalid("Provide the displayed rule and scope.");
        const { lesson, saved } = await this.store.updateReview(reviewId, async (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review))
                throw retiredCommitError(review);
            const proposal = review.lessons.find((item) => item.lessonId === lessonId);
            if (!proposal)
                throw notFound(`Guideline ${lessonId} not found.`);
            if (proposal.rule !== rule || proposal.scope !== scope || (proposal.status !== "proposed" && proposal.status !== "saved")) {
                throw new ReviewError("conflict", "This guideline changed. Review the current proposal before saving.");
            }
            if (proposal.status === "saved") {
                return { write: false, value: { lesson: proposal, saved: false }, journalLessons: [proposal] };
            }
            if (expectedSavedTo !== undefined && typeof expectedSavedTo !== "string") {
                throw invalid("expectedSavedTo must be a string.");
            }
            if (expectedInstructionMappings !== undefined && mapping === undefined) {
                throw invalid("expectedInstructionMappings requires mapping.");
            }
            const expectedMappings = expectedInstructionMappings === undefined
                ? undefined
                : settingsPatch({ instructionMappings: expectedInstructionMappings }).instructionMappings;
            if (proposal.scope === "repo") {
                const reviewedPath = reviewedPathForLesson(review, proposal);
                if (reviewedPath === undefined) {
                    throw new ReviewError("conflict", "This guideline has no recoverable reviewed file location.");
                }
                proposal.reviewedPath = reviewedPath;
                proposal.destination = destinationFromInput(destination, proposal.destination ?? inferRuleDestination(reviewedPath));
            }
            else if (destination !== undefined) {
                proposal.destination = destinationFromInput(destination, proposal.destination ?? { kind: "general" });
            }
            if (mapping === undefined) {
                const didSave = await saveRule(this.store, review.repoRoot, proposal, this.settings, true, expectedSavedTo);
                return { review, value: { lesson: proposal, saved: didSave }, journalLessons: [proposal] };
            }
            if (!this.settings)
                throw new ReviewError("unsupported", "Instruction mapping settings are unavailable.");
            let didSave = false;
            // The confirmed mapping is committed only together with a successful save, and only over the mapping the card showed.
            await this.settings.updateInstructionMappings(review.repoRoot, async (stored) => {
                const selection = mappingsWithConfirmedChoice(stored, mapping, proposal.reviewedPath ?? "");
                if (expectedMappings) {
                    const prefix = selection.mapping.pathPrefix;
                    const current = stored.find((item) => pathKey(item.pathPrefix) === pathKey(prefix));
                    if (!sameMapping(current, expectedMappings.find((item) => pathKey(item.pathPrefix) === pathKey(prefix)))
                        && !sameMapping(current, selection.mapping)) {
                        throw new ReviewError("conflict", "Repository instruction mappings changed after this guideline was shown. Review the current destination and save again.");
                    }
                }
                didSave = await saveRule(this.store, review.repoRoot, proposal, this.settings, true, expectedSavedTo, selection.mapping);
                return didSave ? selection.mappings : stored;
            });
            return { review, value: { lesson: proposal, saved: didSave }, journalLessons: [proposal] };
        });
        if (saved)
            this.changed(reviewId, "message");
        return lesson;
    }
    async previewLessonDestination(reviewId, lessonId, { mapping, destination }) {
        if (!this.settings)
            throw new ReviewError("unsupported", "Instruction mapping settings are unavailable.");
        const review = await this.getReview(reviewId);
        if (isRetiredCommitReview(review))
            throw retiredCommitError(review);
        const proposal = review.lessons.find((item) => item.lessonId === lessonId);
        if (!proposal)
            throw notFound(`Guideline ${lessonId} not found.`);
        if (proposal.scope !== "repo" || (proposal.status ?? "saved") !== "proposed") {
            throw invalid("Only proposed repository guidelines have a configurable destination.");
        }
        const reviewedPath = reviewedPathForLesson(review, proposal);
        if (reviewedPath === undefined)
            throw new ReviewError("conflict", "This guideline has no recoverable reviewed file location.");
        const current = await this.settings.get(review.repoRoot);
        const selection = mappingsWithConfirmedChoice(current.instructionMappings, mapping, reviewedPath);
        const ruleDestination = destinationFromInput(destination, proposal.destination ?? inferRuleDestination(reviewedPath));
        return previewRepositoryRuleDestination(review.repoRoot, selection.mapping, reviewedPath, ruleDestination);
    }
    async setThreadStatus(reviewId, threadId, status) {
        if (typeof status !== "string" || !THREAD_STATUSES.includes(status))
            throw invalid(`status must be one of ${THREAD_STATUSES.join(", ")}.`);
        const thread = await this.store.updateReview(reviewId, (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review))
                throw retiredCommitError(review);
            const t = findThread(review, threadId);
            assertNotArchived(review, threadId);
            t.status = status;
            return { review, value: t };
        });
        this.changed(reviewId, "status");
        return thread;
    }
    // Claim before doing any async prompt work or sending; only one provider may send an attempt.
    async claimDelivery(reviewId, threadId, messageId, { retry = false, senderSessionId } = {}) {
        const claim = await this.store.updateReview(reviewId, (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review))
                throw retiredCommitError(review);
            const message = findThread(review, threadId).messages.find((m) => m.messageId === messageId);
            if (!message || message.author !== "user")
                throw invalid(`Message ${messageId} is not a user message in ${threadId}.`);
            assertNotArchived(review, threadId);
            const current = message.delivery;
            const initial = current?.state === "draft" || (current?.state === "saving" && !current.attempts);
            if (!initial && !(retry && ["failed", "no-reply"].includes(current?.state ?? "")))
                return { write: false, value: null };
            const attempt = { attemptId: randomUUID(), attempts: (current?.attempts ?? 0) + 1 };
            const submittedBatchId = current?.submittedBatchId ?? current?.batchId;
            message.delivery = { state: "saving", ...attempt, submittedBatchId, senderSessionId, claimPid: this.pid, error: null, updatedAt: nowIso() };
            return { review, value: attempt };
        });
        if (claim)
            this.changed(reviewId, "delivery");
        return claim;
    }
    // Claims every draft in one atomic update so a submitted review is sent once, as one batch.
    async claimDrafts(reviewId, { senderSessionId } = {}) {
        const claims = await this.store.updateReview(reviewId, async (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review))
                throw retiredCommitError(review);
            const archived = archivedThreadIds(review);
            const drafts = allMessages(review).filter((e) => e.message.author === "user" && e.message.delivery?.state === "draft" && !archived.has(e.thread.threadId));
            if (!drafts.length)
                return { write: false, value: [] };
            await checkBatchImageBudget(this.store, reviewId, drafts.flatMap(({ message }) => message.imageIds ?? []));
            const batchId = randomUUID();
            const value = drafts.map(({ thread, message }) => {
                const attempt = { attemptId: randomUUID(), attempts: (message.delivery.attempts ?? 0) + 1 };
                message.delivery = { state: "saving", ...attempt, batchId, senderSessionId, claimPid: this.pid, error: null, updatedAt: nowIso() };
                return { threadId: thread.threadId, messageId: message.messageId, ...attempt };
            });
            return { review, value };
        });
        if (claims.length)
            this.changed(reviewId, "delivery");
        return claims;
    }
    // Records how an ask-mode review delivers comments; null asks the reviewer again.
    async setDeliveryChoice(reviewId, mode) {
        if (mode !== null && !REVIEW_DELIVERY_CHOICES.includes(mode)) {
            throw invalid(`mode must be one of ${REVIEW_DELIVERY_CHOICES.join(", ")}, or null.`);
        }
        const changed = await this.store.updateReview(reviewId, (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            if ((review.deliveryMode ?? null) === mode)
                return { write: false, value: false };
            if (mode)
                review.deliveryMode = mode;
            else
                delete review.deliveryMode;
            return { review, value: true };
        });
        if (changed)
            this.changed(reviewId, "delivery-mode");
        return mode;
    }
    // Removes a draft the agent has never seen; a thread left without messages goes with it.
    async discardDraft(reviewId, messageId) {
        const result = await this.store.updateReview(reviewId, (review) => {
            if (!review)
                throw notFound(`Review ${reviewId} not found.`);
            const entry = allMessages(review).find((e) => e.message.messageId === messageId);
            if (!entry)
                throw notFound(`Message ${messageId} not found.`);
            if (entry.message.author !== "user" || entry.message.delivery?.state !== "draft") {
                throw new ReviewError("conflict", `Message ${messageId} is not a draft; only drafts can be discarded.`);
            }
            const { thread } = entry;
            assertNotArchived(review, thread.threadId);
            thread.messages = thread.messages.filter((m) => m !== entry.message);
            const threadRemoved = thread.messages.length === 0;
            if (threadRemoved)
                review.threads = review.threads.filter((t) => t !== thread);
            return { review, value: { threadId: thread.threadId, threadRemoved } };
        });
        this.changed(reviewId, "message");
        return result;
    }
    // A marker is only a lookup hint, never permission to release a draft or transfer processing ownership.
    async processDelivery(reviewId, messageId, { attemptId, sessionMessageId, sessionId, finished = false }) {
        const applied = await this.store.updateReview(reviewId, (review) => {
            const current = review && allMessages(review).find((e) => e.message.messageId === messageId)?.message.delivery;
            // Older queued attempts have no sender field. Only their exact persisted transport event
            // may establish one; a marker by itself (including while saving) cannot do so.
            const legacyQueued = !current?.senderSessionId && current?.state === "queued"
                && sessionMessageId && current.sessionMessageId === sessionMessageId;
            if (!current?.attemptId || !sessionId || (!legacyQueued && current.senderSessionId !== sessionId)
                || !["saving", "queued", "processing"].includes(current.state)
                || (current.processedBy && current.processedBy !== sessionId)
                || (attemptId ? current.attemptId !== attemptId : !sessionMessageId || current.sessionMessageId !== sessionMessageId)
                || (current.sessionMessageId && current.sessionMessageId !== sessionMessageId)) {
                return { write: false, value: false };
            }
            Object.assign(current, { state: finished ? "no-reply" : "processing", senderSessionId: sessionId, processedBy: sessionId, processingAt: nowIso(), updatedAt: nowIso() });
            return { review, value: true };
        });
        if (applied)
            this.changed(reviewId, "delivery");
        return applied;
    }
    // Applies a delivery transition; later states win within the claimed attempt.
    // Non-state fields (e.g. sessionMessageId) are merged even when the state change is ignored.
    async setDelivery(reviewId, messageId, patch, { attemptId } = {}) {
        const applied = await this.store.updateReview(reviewId, (review) => {
            if (!review)
                return { write: false, value: false };
            const entry = allMessages(review).find((e) => e.message.messageId === messageId);
            if (!entry || !entry.message.delivery)
                return { write: false, value: false };
            const current = entry.message.delivery;
            if (attemptId && current.attemptId !== attemptId)
                return { write: false, value: false };
            const { state, ...rest } = patch;
            if (state === "failed" && !["saving", "failed"].includes(current.state))
                return { write: false, value: false };
            const allowState = Boolean(state) && current.state !== "replied"
                && (state === "failed" || DELIVERY_RANK[state] >= DELIVERY_RANK[current.state]);
            if (!allowState && Object.keys(rest).length === 0)
                return { write: false, value: false };
            entry.message.delivery = { ...current, ...rest, ...(allowState ? { state: state } : {}), updatedAt: nowIso() };
            return { review, value: true };
        });
        if (applied)
            this.changed(reviewId, "delivery");
        return applied;
    }
    // Marks user messages still "processing" as unanswered (called when the agent goes idle).
    // With a sessionId, only messages that session was processing are settled; another session's turn may still be running.
    async settleProcessing(reviewId, { sessionId } = {}) {
        const ids = await this.store.updateReview(reviewId, (review) => {
            if (!review)
                return { write: false, value: [] };
            const hits = allMessages(review).filter(({ message }) => message.delivery?.state === "processing" && !message.delivery.parallel
                && (!sessionId || !message.delivery.processedBy || message.delivery.processedBy === sessionId));
            for (const { message } of hits)
                message.delivery = { ...message.delivery, state: "no-reply", updatedAt: nowIso() };
            return hits.length ? { review, value: hits.map((h) => h.message.messageId) } : { write: false, value: [] };
        });
        if (ids.length)
            this.changed(reviewId, "delivery");
        return ids;
    }
    // A comment claimed by a provider process that has since stopped can never be sent, so it is failed
    // and the reviewer can resend it. Claims held by running providers, including other sessions', are left alone.
    async recoverAbandonedClaims(reviewId) {
        const ids = await this.store.updateReview(reviewId, (review) => {
            if (!review)
                return { write: false, value: [] };
            const hits = allMessages(review).filter(({ message }) => {
                const d = message.delivery;
                return d && (d.state === "saving" || d.parallel && ["queued", "processing"].includes(d.state))
                    && Number.isInteger(d.claimPid) && d.claimPid !== this.pid && !this.isProcessAlive(d.claimPid);
            });
            for (const { message } of hits) {
                const delivery = message.delivery;
                message.delivery = {
                    ...delivery, state: "failed",
                    error: !delivery?.parallel
                        ? "The extension stopped before this comment was sent. Resend it."
                        : delivery.state === "queued"
                            ? "The extension restarted before parallel analysis started. Nothing was changed; resend it."
                            : "Parallel processing was interrupted. Check the reviewed checkout for any applied changes before resending.",
                    updatedAt: nowIso(),
                };
            }
            return hits.length ? { review, value: hits.map((h) => h.message.messageId) } : { write: false, value: [] };
        });
        if (ids.length)
            this.changed(reviewId, "delivery");
        return ids;
    }
    async findMessage(reviewId, messageId) {
        const review = await this.getReview(reviewId);
        const entry = allMessages(review).find((e) => e.message.messageId === messageId);
        if (!entry)
            throw notFound(`Message ${messageId} not found.`);
        return { review, thread: entry.thread, message: entry.message };
    }
    async revisionLines(reviewId, revisionId, filePath) {
        const review = await this.getReview(reviewId);
        this.git.safeJoin(review.repoRoot, filePath);
        const snapshot = await this.getSnapshot(reviewId, revisionId);
        const file = snapshot.files.find((entry) => entry.path === filePath);
        if (!file || file.binary || file.status === "deleted") {
            throw new ReviewError("conflict", `Cannot recover ${filePath} from revision ${revisionId}. Check the selection before retrying.`);
        }
        // Anchors must use immutable revision content, not the now-edited working file.
        const base = file.status === "added" ? [] : await this.git.readCommitFile(review.repoRoot, snapshot.baseCommit, file.oldPath ?? filePath);
        if (base?.[base.length - 1] === "")
            base.pop();
        const lines = base && base.length <= MAX_FULL_FILE_LINES ? revisionContent(file, base) : null;
        if (!lines || lines.length > MAX_FULL_FILE_LINES) {
            throw new ReviewError("conflict", `Cannot recover full-file content for ${filePath} from revision ${revisionId}. Check the selection before retrying.`);
        }
        return lines;
    }
    // Everything the agent prompt needs for one message, resolved against the current revision.
    async promptContext(reviewId, threadId) {
        const review = await this.getReview(reviewId);
        const thread = findThread(review, threadId);
        let excerpt = null;
        let selected = null;
        const loc = thread.location;
        if (loc && (thread.kind === "line" || thread.kind === "change") && loc.state !== "outdated") {
            const snapshot = await this.store.readSnapshot(reviewId, loc.revisionId);
            const file = snapshot?.files.find((f) => f.path === loc.path);
            if (file) {
                excerpt = hunkExcerpt(file, loc.side, loc.startLine, loc.endLine);
                selected = selectedLines(file, loc.side, loc.startLine, loc.endLine);
            }
            if (!selected || selected.length !== loc.endLine - loc.startLine + 1) {
                const content = loc.side === "old"
                    ? await this.git.readCommitFile(review.repoRoot, snapshot?.baseCommit, thread.anchor.oldPath ?? loc.path)
                    : await this.revisionLines(reviewId, loc.revisionId, loc.path);
                selected = content ? content.slice(loc.startLine - 1, loc.endLine) : selected;
            }
        }
        if (loc && thread.kind === "file") {
            const snapshot = await this.store.readSnapshot(reviewId, loc.revisionId);
            const file = snapshot?.files.find((f) => f.path === loc.path);
            if (file && file.oldMode !== file.newMode && (file.oldMode || file.newMode)) {
                excerpt = { text: `File mode: ${file.oldMode ?? "(absent)"} to ${file.newMode ?? "(absent)"}` };
            }
        }
        return {
            review: {
                ...review,
                headCommit: review.git?.headCommit,
                baseCommit: review.git?.baseCommit,
            },
            thread,
            excerpt,
            selected,
        };
    }
    // The agent's view of a review. Drafts are still held by the reviewer, so only their count is shown.
    summarize(review, { threadId, includeResolved = false, maxBody = 2000 } = {}) {
        if (isRetiredCommitReview(review))
            throw retiredCommitError(review);
        const isDraft = (m) => m.author === "user" && m.delivery?.state === "draft";
        const archived = archivedThreadIds(review);
        const visible = review.threads.filter((t) => t.messages.some((m) => !isDraft(m)));
        const threads = visible.filter((t) => (threadId ? t.threadId === threadId : includeResolved || (t.status === "active" && !archived.has(t.threadId))));
        return {
            reviewId: review.reviewId,
            title: review.title,
            description: review.description ?? null,
            repoRoot: review.repoRoot,
            branch: review.branch,
            base: review.base,
            scope: scopeOf(review),
            currentRevisionId: review.currentRevisionId,
            git: review.git,
            completions: review.completions ?? [],
            counts: {
                total: visible.length,
                active: visible.filter((t) => t.status === "active" && !archived.has(t.threadId)).length,
                archived: visible.filter((t) => archived.has(t.threadId)).length,
                awaitingAgent: allMessages(review).filter((e) => ["queued", "processing", "failed", "no-reply"].includes(e.message.delivery?.state ?? "")).length,
                drafts: allMessages(review).filter((e) => isDraft(e.message) && !archived.has(e.thread.threadId)).length,
            },
            threads: threads.map((t) => ({
                threadId: t.threadId,
                kind: t.kind,
                agentReview: t.agentReview,
                status: t.status,
                ...(archived.has(t.threadId) ? { archived: true } : {}),
                ...(t.followUpOf ? { followUpOf: t.followUpOf } : {}),
                location: t.location,
                originalLocation: t.anchor ? { revisionId: t.anchor.revisionId, path: t.anchor.path, side: t.anchor.side, startLine: t.anchor.startLine, endLine: t.anchor.endLine } : null,
                messages: t.messages.filter((m) => !isDraft(m)).map((m) => ({
                    messageId: m.messageId,
                    author: m.author,
                    createdAt: m.createdAt,
                    body: m.body.length > maxBody ? `${m.body.slice(0, maxBody)}...` : m.body,
                    ...(m.imageIds?.length ? { imageCount: m.imageIds.length } : {}),
                    delivery: m.delivery?.state,
                    outcome: m.outcome,
                })),
            })),
            lessons: review.lessons.map((l) => ({ ...l, status: l.status ?? "saved" })),
        };
    }
}
