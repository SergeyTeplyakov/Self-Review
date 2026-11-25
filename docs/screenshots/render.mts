// Renders the README screenshots from a scripted demo review.
//
// Builds throwaway git repos, seeds reviews through the same ReviewService the canvas
// uses, serves the real web UI, and captures it with Playwright in light and dark themes.
//
//   cd docs/screenshots
//   npm install
//   node render.mjs           render every shot into docs/images
//   node render.mjs --only=comment,batch  write only the selected shots
//   node render.mjs --keep    also keep the demo review running and print its URL
//
// Uses an installed Edge or Chrome when available (set MR_BROWSER_CHANNEL to pick one).
// Without either, run `npx playwright-core install chromium` first.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright-core";
import assert from "node:assert/strict";
import type { ReviewService as ReviewServiceContract } from "../../extensions/self-review/src/lib/review-service.mjs";
import {
    AgentReview, Delivery, ReviewService, ReviewSkills, SettingsService, Store, runGit, startReviewServer,
} from "../../extensions/self-review/test/modules.mjs";
import { parseExtensionVersion } from "../../extensions/self-review/src/lib/extension-version.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HERE = path.join(REPOSITORY_ROOT, "docs", "screenshots");
const WEB_ROOT = path.join(HERE, "..", "..", "extensions", "self-review", "dist", "web");
const EXTENSION_VERSION_PATH = path.join(REPOSITORY_ROOT, "extensions", "self-review", "dist", "version.json");
const OUT = path.join(HERE, "..", "images");
const KEEP = process.argv.includes("--keep");
const CHECK_REFRESH = process.argv.includes("--check-refresh-layout");
const CHECK_SEED = process.argv.includes("--check-seed");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",");
const WIDTH = 1320;
const THEMES: Array<"light" | "dark"> = ["light", "dark"];

// ---------- Demo repository ----------

const file = (text: string) => text.replace(/^\n/, "");

const MAIN = {
    "package.json": file(`
{
  "name": "orders-api",
  "version": "1.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
`),
    "README.md": file(`
# orders-api

Typed client for the internal orders backend.

\`\`\`ts
const orders = new OrderService();
const order = await orders.getOrder("o-1042");
\`\`\`
`),
    "src/config.ts": file(`
export interface HttpConfig {
    baseUrl: string;
    timeoutMs: number;
}

export const defaultConfig: HttpConfig = {
    baseUrl: process.env.ORDERS_BASE_URL ?? "https://orders.internal",
    timeoutMs: 10_000,
};
`),
    "src/http/client.ts": file(`
import { defaultConfig, type HttpConfig } from "../config.js";
import { withTimeout } from "./timeout.js";

export class HttpClient {
    constructor(private readonly config: HttpConfig = defaultConfig) {}

    async get<T>(path: string): Promise<T> {
        const response = await withTimeout(fetch(new URL(path, this.config.baseUrl)), this.config.timeoutMs);
        if (!response.ok) {
            throw new HttpError(response.status, await response.text());
        }
        return (await response.json()) as T;
    }
}

export class HttpError extends Error {
    constructor(readonly status: number, body: string) {
        super(\`HTTP \${status}: \${body.slice(0, 200)}\`);
    }
}
`),
    "src/http/timeout.ts": file(`
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(\`Timed out after \${ms} ms\`)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
`),
    "src/orders/service.ts": file(`
import { HttpClient } from "../http/client.js";

export interface Order {
    id: string;
    status: "pending" | "shipped" | "cancelled";
    totalCents: number;
}

export class OrderService {
    constructor(private readonly http = new HttpClient()) {}

    getOrder(id: string): Promise<Order> {
        return this.http.get<Order>(\`/orders/\${encodeURIComponent(id)}\`);
    }
}
`),
    "test/client.test.ts": file(`
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../src/http/client.js";

const config = { baseUrl: "https://orders.test", timeoutMs: 1_000 };

afterEach(() => vi.unstubAllGlobals());

describe("HttpClient", () => {
    it("returns the parsed body", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "o-1" })));
        await expect(new HttpClient(config).get("/orders/o-1")).resolves.toEqual({ id: "o-1" });
    });

    it("throws HttpError for non-2xx responses", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
        await expect(new HttpClient(config).get("/orders/o-1")).rejects.toBeInstanceOf(HttpError);
    });
});
`),
};

// Revision 1: the committed and pushed feature branch.
const FEATURE = {
    "README.md": MAIN["README.md"] + file(`

## Retries

\`HttpClient\` retries throttling, server errors and network failures with exponential backoff.
Tune it with \`retry\` in \`src/config.ts\`.
`),
    "src/config.ts": file(`
import type { RetryPolicy } from "./http/retry.js";

export interface HttpConfig {
    baseUrl: string;
    timeoutMs: number;
    retry: RetryPolicy;
}

export const defaultConfig: HttpConfig = {
    baseUrl: process.env.ORDERS_BASE_URL ?? "https://orders.internal",
    timeoutMs: 10_000,
    retry: {
        maxAttempts: 4,
        baseDelayMs: 200,
        maxDelayMs: 5_000,
    },
};
`),
    "src/http/client.ts": file(`
import { defaultConfig, type HttpConfig } from "../config.js";
import { withRetry } from "./retry.js";

export class HttpClient {
    constructor(private readonly config: HttpConfig = defaultConfig) {}

    async get<T>(path: string): Promise<T> {
        return withRetry(this.config.retry, async () => {
            const response = await fetch(new URL(path, this.config.baseUrl), {
                signal: AbortSignal.timeout(this.config.timeoutMs),
            });
            if (!response.ok) {
                const retryAfter = response.headers.get("retry-after");
                throw new HttpError(response.status, await response.text(), retryAfter);
            }
            return (await response.json()) as T;
        });
    }
}

export class HttpError extends Error {
    constructor(
        readonly status: number,
        body: string,
        readonly retryAfter: string | null = null,
    ) {
        super(\`HTTP \${status}: \${body.slice(0, 200)}\`);
    }
}
`),
    "src/http/retry.ts": file(`
import { HttpError } from "./client.js";

export interface RetryPolicy {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryable(error: unknown): boolean {
    if (error instanceof HttpError) return RETRYABLE_STATUS.has(error.status);
    return error instanceof TypeError; // fetch reports network failures as TypeError
}

export function computeDelay(policy: RetryPolicy, attempt: number): number {
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, policy.maxDelayMs);
}

export async function withRetry<T>(policy: RetryPolicy, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= policy.maxAttempts || !isRetryable(error)) throw error;
            await sleep(computeDelay(policy, attempt));
        }
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
`),
    "src/http/timeout.ts": null,
    "test/client.test.ts": file(`
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../src/http/client.js";

const config = {
    baseUrl: "https://orders.test",
    timeoutMs: 1_000,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
};

afterEach(() => vi.unstubAllGlobals());

describe("HttpClient", () => {
    it("returns the parsed body", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "o-1" })));
        await expect(new HttpClient(config).get("/orders/o-1")).resolves.toEqual({ id: "o-1" });
    });

    it("throws HttpError for non-2xx responses", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
        await expect(new HttpClient(config).get("/orders/o-1")).rejects.toBeInstanceOf(HttpError);
    });

    it("retries a 503 and returns the next response", async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response("busy", { status: 503 }))
            .mockResolvedValueOnce(Response.json({ id: "o-1" }));
        vi.stubGlobal("fetch", fetch);
        await expect(new HttpClient(config).get("/orders/o-1")).resolves.toEqual({ id: "o-1" });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
`),
    "test/retry.test.ts": file(`
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http/client.js";
import { computeDelay, isRetryable } from "../src/http/retry.js";

const policy = { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 5_000 };

describe("isRetryable", () => {
    it("retries throttling and server errors", () => {
        expect(isRetryable(new HttpError(429, ""))).toBe(true);
        expect(isRetryable(new HttpError(503, ""))).toBe(true);
    });

    it("does not retry other client errors", () => {
        expect(isRetryable(new HttpError(400, ""))).toBe(false);
        expect(isRetryable(new HttpError(409, ""))).toBe(false);
    });
});

describe("computeDelay", () => {
    it("grows exponentially up to maxDelayMs", () => {
        expect(computeDelay(policy, 1)).toBe(200);
        expect(computeDelay(policy, 6)).toBe(5_000);
    });
});
`),
};

const RETRY_TEST_HEAD = FEATURE["test/retry.test.ts"].slice(0, FEATURE["test/retry.test.ts"].indexOf('describe("computeDelay"'));

// Revision 2 (uncommitted): full jitter and Retry-After, after the first review round.
const R2 = {
    "src/http/retry.ts": FEATURE["src/http/retry.ts"]
        .replace(file(`
export function computeDelay(policy: RetryPolicy, attempt: number): number {
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, policy.maxDelayMs);
}
`), file(`
export function computeDelay(policy: RetryPolicy, attempt: number, error: unknown): number {
    const retryAfter = error instanceof HttpError ? parseRetryAfter(error.retryAfter) : null;
    if (retryAfter != null) return retryAfter;
    // Full jitter: spread retries so clients don't hit a recovering backend in lockstep.
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
    return Math.random() * Math.min(exponential, policy.maxDelayMs);
}
`))
        .replace("await sleep(computeDelay(policy, attempt));", "await sleep(computeDelay(policy, attempt, error));")
        .replace("const sleep =", file(`
// Retry-After is either delay-seconds or an HTTP-date (RFC 9110, section 10.2.3).
function parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const sleep =`)),
    "test/retry.test.ts": RETRY_TEST_HEAD + file(`
describe("computeDelay", () => {
    it("stays within the exponential bound", () => {
        for (let attempt = 1; attempt <= 6; attempt++) {
            const delay = computeDelay(policy, attempt, new HttpError(503, ""));
            expect(delay).toBeLessThanOrEqual(Math.min(200 * 2 ** (attempt - 1), 5_000));
        }
    });

    it("honors Retry-After in seconds", () => {
        expect(computeDelay(policy, 1, new HttpError(429, "", "2"))).toBe(2_000);
    });
});
`),
};

// Revision 3 (uncommitted): Retry-After is clamped, after the second review round.
const R3 = {
    "src/http/retry.ts": R2["src/http/retry.ts"].replace(
        "if (retryAfter != null) return retryAfter;",
        "if (retryAfter != null) return Math.min(retryAfter, policy.maxDelayMs);"),
    "test/retry.test.ts": R2["test/retry.test.ts"].replace(/\n\}\);\n$/, "\n" + file(`

    it("clamps Retry-After to maxDelayMs", () => {
        expect(computeDelay(policy, 1, new HttpError(429, "", "3600"))).toBe(5_000);
    });
});
`)),
};

const DESCRIPTION = (clamped: boolean) => [
    "Transient failures from the orders backend (throttling, deployments, dropped connections) currently fail the request on the first attempt. This adds a retry policy to `HttpClient`.",
    "",
    "### Behavior",
    "- Retries 408, 429, 500, 502, 503, 504 and network errors, up to `maxAttempts` (default 4).",
    "- Exponential backoff with full jitter, capped at `maxDelayMs`.",
    clamped
        ? "- Honors `Retry-After` (seconds or HTTP-date), clamped to `maxDelayMs`."
        : "- Honors `Retry-After` (seconds or HTTP-date).",
    "- Replaces the hand-rolled `withTimeout` helper with `AbortSignal.timeout`.",
    "",
    "### Verification",
    `- \`npm test\`: ${clamped ? 9 : 8} passed, including the new \`retry.test.ts\`.`,
    "",
    "### Risks",
    "- Non-idempotent requests are retried too; see the open thread on `withRetry`.",
].join("\n");

const git = (cwd: string, ...args: string[]) => runGit(cwd, [
    "-c", "user.name=Demo", "-c", "user.email=demo@example.com",
    "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args]);

async function writeFiles(repo: string, files: Record<string, string | Uint8Array | null>) {
    for (const [rel, text] of Object.entries(files)) {
        const full = path.join(repo, ...rel.split("/"));
        if (text === null) {
            await rm(full, { force: true });
        } else {
            await mkdir(path.dirname(full), { recursive: true });
            await writeFile(full, text);
        }
    }
}

function lineOf(text: string, needle: string) {
    const index = text.split("\n").findIndex((l) => l.includes(needle));
    if (index < 0) throw new Error(`Demo anchor not found: ${needle}`);
    return index + 1;
}

// ---------- Seed the review ----------

async function seed(tmp: string) {
    const repo = path.join(tmp, "orders-api");
    const origin = path.join(tmp, "orders-api.git");
    await runGit(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await writeFiles(repo, MAIN);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "Add orders client");
    await git(repo, "remote", "add", "origin", origin);
    await git(repo, "push", "-q", "-u", "origin", "main");
    await git(repo, "checkout", "-q", "-b", "feature/retry-policy");
    await writeFiles(repo, FEATURE);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "Retry transient failures in HttpClient");
    await git(repo, "push", "-q", "-u", "origin", "feature/retry-policy");

    const store = new Store(path.join(tmp, "data"));
    const settings = new SettingsService({ store });
    await settings.update(repo, { instructionMappings: [{ pathPrefix: "", instructionRoot: "", splitLanguageSpecific: false }] });
    const service: ReviewServiceContract = new ReviewService({ store, settings });
    let reviewId = "";
    const delivery = new Delivery({
        service,
        send: async () => "demo",
        log: () => {},
        reviewIds: () => [reviewId],
    });
    reviewId = await service.ensureReview({
        repoPath: repo, base: "main", title: "Retry transient failures in HttpClient",
        exclude: [".github/copilot-instructions.md"],
    });

    // Backdate everything afterwards so the UI shows a plausible timeline instead of "just now".
    const minutesAgo = new Map();
    const revision = async (minutes: number) => {
        const { currentRevisionId } = await service.getReview(reviewId);
        minutesAgo.set(currentRevisionId, minutes);
    };
    const comment = async (minutes: number, input: Parameters<ReviewServiceContract["createThread"]>[1]) => {
        const { thread, message } = await service.createThread(reviewId, input);
        minutesAgo.set(message.messageId, minutes);
        return { threadId: thread.threadId, messageId: message.messageId };
    };
    const onLine = (minutes: number, files: Record<string, string | null>, filePath: string, needle: string, body: string) => {
        const text = files[filePath];
        if (text === null || text === undefined) throw new Error(`Demo file is missing: ${filePath}`);
        const line = lineOf(text, needle);
        return comment(minutes, { kind: "line", path: filePath, side: "new", startLine: line, endLine: line, body });
    };
    const reply = async (
        minutes: number,
        threadId: string,
        input: Parameters<ReviewServiceContract["addMessage"]>[2],
    ) => {
        const { message } = await service.addMessage(reviewId, threadId, { author: "agent", ...input });
        minutesAgo.set(message.messageId, minutes);
        return message;
    };
    const nextRevision = async (files: Record<string, string | null>, minutes: number) => {
        await writeFiles(repo, files);
        await service.refresh(reviewId);
        await revision(minutes);
    };

    await revision(44);
    const overall = await comment(42, { kind: "overview", body: "Draft the description. Keep it short; reviewers skim." });
    await service.updateDescription(reviewId, { body: DESCRIPTION(false), expectedVersion: 0 });
    await reply(40, overall.threadId, {
        outcome: "answered",
        body: "Drafted it above: purpose, behavior, verification and risks. Short descriptions look like a personal preference, so I proposed a guideline below.",
        lessons: [{ scope: "personal", rule: "Keep PR descriptions short: purpose, behavior change, verification, risks.", status: "proposed" }],
    });

    const jitter = await onLine(36, FEATURE, "src/http/retry.ts", "return Math.min(exponential, policy.maxDelayMs);",
        "No jitter, so after an outage every client retries in lockstep and hits the backend at the same moment. Use full jitter, and honor `Retry-After` on 429 and 503.");
    const header = await onLine(33, FEATURE, "src/http/client.ts", 'const retryAfter = response.headers.get("retry-after");',
        "Parse `Retry-After` here and store milliseconds instead of carrying the raw header around.");
    await reply(31, header.threadId, {
        outcome: "disagreed",
        body: "I'd keep the raw header. `Retry-After` can be an HTTP-date, which is relative to the current time, so parsing it here makes the delay stale by the time `withRetry` sleeps. `computeDelay` parses it right before waiting.",
    });

    await nextRevision(R2, 27);
    const jitterRule = "Retries use exponential backoff with full jitter and honor `Retry-After`.";
    const jitterReply = await reply(26, jitter.threadId, {
        outcome: "changed",
        body: "Switched to full jitter: the delay is now uniform in `[0, min(base * 2^n, maxDelayMs)]`. `Retry-After` (seconds or HTTP-date) wins when the server sends it.",
        verification: "`npm test -- retry`: 5 passed",
        lessons: [{ scope: "repo", rule: jitterRule }],
    });
    const savedJitter = await service.saveLesson(reviewId, jitterReply.lessonIds![0], { scope: "repo", rule: jitterRule });
    assert.equal(savedJitter.status, "saved", savedJitter.saveError);
    assert.equal(savedJitter.savedTo, ".github/copilot-instructions.md");
    await service.setThreadStatus(reviewId, jitter.threadId, "resolved");

    const clamp = await onLine(15, R2, "src/http/retry.ts", "const retryAfter = error instanceof HttpError",
        "Clamp this. A server that sends `Retry-After: 3600` would stall the request for an hour.");
    await nextRevision(R3, 9);
    const clampRule = "Clamp server-supplied delays such as `Retry-After` to the configured maximum.";
    const clampReply = await reply(8, clamp.threadId, {
        outcome: "changed",
        body: "`Retry-After` is now clamped to `maxDelayMs`, the same cap as the computed backoff. Added a test for a one-hour value.",
        verification: "`npm test -- retry`: 6 passed",
        lessons: [{ scope: "repo", rule: clampRule }],
    });
    const savedClamp = await service.saveLesson(reviewId, clampReply.lessonIds![0], { scope: "repo", rule: clampRule });
    assert.equal(savedClamp.status, "saved", savedClamp.saveError);
    assert.equal(savedClamp.savedTo, ".github/copilot-instructions.md");
    const instructions = await readFile(path.join(repo, ".github", "copilot-instructions.md"), "utf8");
    assert.ok(instructions.includes(jitterRule) && instructions.includes(clampRule));
    await service.updateDescription(reviewId, { body: DESCRIPTION(true), expectedVersion: 1 });

    const idempotent = await onLine(3, R3, "src/http/retry.ts", "export async function withRetry",
        "This retries POSTs too. Only retry idempotent requests unless the caller passes an idempotency key.");
    await service.setDelivery(reviewId, idempotent.messageId, { state: "processing", processingAt: new Date().toISOString() });
    const knob = await onLine(1, FEATURE, "src/config.ts", "maxAttempts: 4,",
        "Read this from `ORDERS_RETRY_MAX_ATTEMPTS` so we can tune it without a deploy.");
    await service.setDelivery(reviewId, knob.messageId, { state: "queued", queuedAt: new Date().toISOString() });
    delivery.setBusy(true);

    await store.updateReview(reviewId, (review) => {
        if (!review) throw new Error("Demo review disappeared before its timestamps were updated.");
        const iso = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
        const stamp = (item: { createdAt: string }, id: string) => {
            const offset = minutesAgo.get(id);
            if (offset !== undefined) item.createdAt = iso(offset);
        };
        for (const rev of review.revisions) stamp(rev, rev.revisionId);
        for (const thread of review.threads) {
            for (const message of thread.messages) stamp(message, message.messageId);
            thread.createdAt = thread.messages[0].createdAt;
        }
        for (const lesson of review.lessons) {
            const message = review.threads.flatMap((t) => t.messages).find((m) => m.messageId === lesson.messageId);
            if (message) lesson.createdAt = message.createdAt;
        }
        return { review };
    });

    const outdated = (await service.getReview(reviewId)).threads.find((thread) => thread.threadId === jitter.threadId);
    if (!outdated || outdated.location?.state !== "outdated") {
        throw new Error("Expected the jitter thread to be outdated after revision 2.");
    }

    return { reviewId, service, delivery, store, threads: { clamp: clamp.threadId, idempotent: idempotent.threadId } };
}

// ---------- Image diff review ----------

type Rgba = readonly [number, number, number, number];

// Encodes an 8-bit RGBA PNG, so the demo images need no binary fixtures in the repository.
function png(width: number, height: number, pixel: (x: number, y: number) => Rgba): Buffer {
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * stride + 1 + x * 4);
    }
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
        const framed = Buffer.alloc(body.length + 8);
        framed.writeUInt32BE(data.length, 0);
        body.copy(framed, 4);
        framed.writeUInt32BE(crc32(body), body.length + 4);
        return framed;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, not interlaced
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const CHART = { width: 640, height: 360, padding: 36 };
const AXIS: Rgba = [101, 109, 118, 255];
const TRANSPARENT: Rgba = [0, 0, 0, 0];

// Bars on a transparent background, so the review's checkerboard shows around them.
function barChart(bars: number[], color: Rgba): Buffer {
    const { width, height, padding } = CHART;
    const baseline = height - padding;
    const slot = (width - 2 * padding) / bars.length;
    return png(width, height, (x, y) => {
        if (x >= padding && x < width - padding && y >= baseline && y < baseline + 3) return AXIS;
        const index = Math.floor((x - padding) / slot);
        const left = padding + index * slot;
        const inBar = index >= 0 && index < bars.length && x >= left + slot * 0.2 && x < left + slot * 0.8
            && y < baseline && y >= baseline - bars[index] * (baseline - padding);
        return inBar ? color : TRANSPARENT;
    });
}

const logo = (fill: string, mark: boolean) => file(`
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <circle cx="48" cy="48" r="40" fill="${fill}"/>
${mark ? '  <path d="M30 50 l12 12 l24 -26" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>\n' : ""}</svg>
`);

async function seedImages(tmp: string, service: ReviewServiceContract) {
    const repo = path.join(tmp, "dashboard");
    const origin = path.join(tmp, "dashboard.git");
    await runGit(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await writeFiles(repo, {
        "assets/usage-chart.png": barChart([0.42, 0.66, 0.5, 0.78], [9, 105, 218, 255]),
        "assets/logo.svg": logo("#0969da", false),
    });
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "Add dashboard assets");
    await git(repo, "remote", "add", "origin", origin);
    await git(repo, "push", "-q", "-u", "origin", "main");
    await git(repo, "checkout", "-q", "-b", "feature/weekly-usage");
    await writeFiles(repo, {
        "assets/usage-chart.png": barChart([0.48, 0.72, 0.58, 0.88, 0.64], [26, 127, 55, 255]),
        "assets/logo.svg": logo("#1a7f37", true),
    });
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "Show weekly usage");
    await git(repo, "push", "-q", "-u", "origin", "feature/weekly-usage");
    return service.ensureReview({ repoPath: repo, base: "main", title: "Show weekly usage on the dashboard" });
}

// ---------- Capture ----------

async function launchBrowser(): Promise<Browser> {
    const channels = [...new Set([process.env.MR_BROWSER_CHANNEL, "msedge", "chrome"].filter(Boolean)), undefined];
    let lastError;
    for (const channel of channels) {
        try {
            return await chromium.launch(channel ? { channel } : {});
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

async function nav(page: Page, view: string, filePath?: string) {
    const pathSelector = filePath ? `[data-path="${filePath}"]` : "";
    await page.locator(`#side [data-action="nav"][data-view="${view}"]${pathSelector}`).first().click();
    if (view === "file") {
        await page.locator(`.file-section[data-file="${filePath}"] .diff`).waitFor();
        await page.waitForFunction(() => ![...document.querySelectorAll(".full-note")].some((n) => n.textContent?.startsWith("Loading")));
    }
    await page.evaluate(() => {
        const main = document.querySelector("#main");
        if (!(main instanceof HTMLElement)) throw new Error("Main content pane is missing.");
        main.scrollTo(0, 0);
    });
    await page.waitForTimeout(250);
}

async function checkRefreshLayout(browser: Browser, url: string) {
    const page = await browser.newPage({ viewport: { width: 480, height: 750 } });
    try {
        await page.clock.install();
        await page.goto(url);
        const status = page.locator("#review-status");
        const statusSlot = page.locator("#review-status-slot");
        const controls = page.locator("#review-status-controls");
        const refresh = page.locator('#top [data-action="refresh"]');
        const file = page.locator('#side [data-view="file"]').first();
        await file.waitFor();
        await status.waitFor({ state: "hidden" });
        const geometry = () => Promise.all([file, page.locator("#main"), refresh, controls, statusSlot].map((element) => element.boundingBox()));
        const assertStatusAlignment = async () => {
            const [controlBounds, statusBounds, slotBounds] = await Promise.all([controls, status, statusSlot].map((element) => element.boundingBox()));
            assert.ok(controlBounds && statusBounds && slotBounds, "footer controls and status must have layout boxes");
            assert.ok(statusBounds.x >= controlBounds.x + controlBounds.width, "refresh status must remain to the right of footer controls");
            assert.ok(Math.abs(statusBounds.x + statusBounds.width - (slotBounds.x + slotBounds.width - 16)) <= 1, "refresh status must align with the footer's right edge");
            assert.equal(await status.evaluate((element) => getComputedStyle(element).justifyContent), "flex-end");
            assert.equal(await status.locator(".review-status-message").evaluate((element) => getComputedStyle(element).textAlign), "right");
        };
        const original = await geometry();
        let fail = true;
        await page.route("**/api/refresh", async (route) => {
            await status.filter({ hasText: "Showing the last loaded data" }).waitFor();
            assert.deepEqual(await geometry(), original, "refresh progress must not shift the review");
            await assertStatusAlignment();
            if (fail) {
                await route.fulfill({ status: 500, json: { error: { message: "Long capture error: bad revision 'origin/main'. ".repeat(20) } } });
            } else {
                await route.continue();
            }
        });
        await refresh.click();
        const retry = status.getByRole("button", { name: "Retry" });
        await retry.waitFor();
        assert.match((await status.textContent()) ?? "", /Long capture error/);
        assert.deepEqual(await geometry(), original, "a long error must not shift the review");
        await assertStatusAlignment();
        const errorMessage = status.locator(".review-status-message");
        const offset = await errorMessage.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
            return element.scrollTop;
        });
        assert.ok(offset > 0, "the long refresh error must scroll");
        await page.clock.fastForward(30_000);
        assert.equal(await errorMessage.evaluate((element) => element.scrollTop), offset, "an unchanged error must retain its scroll position");
        fail = false;
        await retry.click();
        await page.locator("#toast").filter({ hasText: "Refreshed from the working tree" }).waitFor();
        await status.waitFor({ state: "hidden" });
        assert.deepEqual(await geometry(), original, "successful retry must restore idle without shifting the review");
    } finally {
        await page.close();
    }
}

// Sizes the viewport to the content of both panes (up to maxHeight) so the shot has no scrolling
// and no trailing whitespace. scrollHeight is unusable here: it never drops below the pane height.
async function fitHeight(page: Page, maxHeight: number) {
    const needed = await page.evaluate(() => {
        const main = document.querySelector("#main");
        if (!(main instanceof HTMLElement)) throw new Error("Main content pane is missing.");
        const bottoms = [...main.children].map((el) => el.getBoundingClientRect().bottom + main.scrollTop);
        bottoms.push(...[...document.querySelectorAll("#side .nav-item")].map((el) => el.getBoundingClientRect().bottom));
        const statusHeight = document.querySelector("#review-status-slot")?.getBoundingClientRect().height ?? 0;
        return Math.ceil(Math.max(...bottoms) + 16 + statusHeight);
    });
    await page.setViewportSize({ width: WIDTH, height: Math.min(needed, maxHeight) });
    await page.waitForTimeout(250);
}

// A scripted agentic review for the activity panel: one model has reported, two are still reviewing, and an
// earlier run failed (the panel lists only the active run; the Agent reviews page behind it lists both).
// The browser sees it in the review state only; the provider never stores or starts a run.
function demoAgentRuns(review: { currentRevisionId: string; revisions: Array<{ revisionId: string }> }) {
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
    const earlier = review.revisions[0]?.revisionId ?? review.currentRevisionId;
    return [
        {
            runId: "demo-earlier", state: "failed", protocol: "consensus-v1", focus: "simplify", revisionId: earlier,
            createdAt: ago(3 * 3600), finishedAt: ago(3 * 3600 - 260), models: ["gpt-6-astra", "gpt-6.1-sol"],
            error: "gpt-6.1-sol did not report, so no findings were published.",
            results: [
                { model: "gpt-6-astra", state: "completed", threadIds: [], candidates: [{}, {}], finishedAt: ago(3 * 3600 - 190) },
                { model: "gpt-6.1-sol", state: "failed", threadIds: [], error: "Model gpt-6.1-sol is not available to this session.", finishedAt: ago(3 * 3600 - 12) },
            ],
        },
        {
            runId: "demo-live", state: "running", protocol: "consensus-v1", focus: "both", revisionId: review.currentRevisionId,
            createdAt: ago(95), models: ["gpt-6-astra", "gpt-6.1-sol", "copilot-fusion"],
            results: [{ model: "gpt-6-astra", state: "completed", threadIds: [], candidates: [{}, {}, {}], finishedAt: ago(33) }],
        },
    ];
}

async function capture(
    browser: Browser,
    url: string,
    theme: "light" | "dark",
    resetLearning: () => Promise<void>,
    notifyReviewChanged: () => void,
) {
    await resetLearning();
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator("#side .nav-item").first().waitFor();
    const shot = async (name: string, clip?: { x: number; y: number; width: number; height: number }, from: Page = page) => {
        if (only && !only.includes(name)) return;
        const target = path.join(OUT, `${name}-${theme}.png`);
        await from.screenshot({ path: target, clip });
        console.log(`  ${path.relative(process.cwd(), target)}`);
    };

    // Choosing manual saving in the notice dismisses it for this repository.
    await page.locator("#banner:not([hidden])").waitFor();
    const banner = await page.locator("#banner").boundingBox();
    if (!banner) throw new Error("Learning banner is not visible.");
    await shot("banner", { x: 0, y: 0, width: WIDTH, height: Math.ceil(banner.y + banner.height) });
    await page.locator('#banner [data-action="learning-set"][data-enabled="false"]').click();
    await page.locator("#banner").waitFor({ state: "hidden" });
    await page.locator("#toast").waitFor({ state: "hidden" });

    // A file with an answered thread (change, verification, lesson) and one Copilot is working on.
    await nav(page, "file", "src/http/retry.ts");
    await fitHeight(page, 1290);
    await shot("conversation");

    // Selecting lines in a modified file opens an inline composer.
    await nav(page, "file", "src/http/client.ts");
    await fitHeight(page, 1050);
    const first = page.locator("tr.row.add", { hasText: "const response = await fetch(" }).first();
    const last = page.locator("tr.row.add", { hasText: "signal: AbortSignal.timeout(" }).first();
    await first.locator("td.ln").nth(1).hover();
    await page.mouse.down();
    await last.locator("td.ln").nth(1).hover();
    await page.mouse.up();
    const composer = page.locator("textarea[data-composer^='line:']");
    await composer.waitFor();
    await composer.focus();
    await page.keyboard.type("Log each attempt with its status code, so retry storms show up on the dashboard.");
    await composer.evaluate(async (field) => {
        const fixture = document.createElement("canvas");
        fixture.width = 200;
        fixture.height = 85;
        const ctx = fixture.getContext("2d");
        if (!ctx) throw new Error("Cannot draw the clipboard fixture.");
        ctx.fillStyle = "#182230";
        ctx.fillRect(0, 0, fixture.width, fixture.height);
        ctx.fillStyle = "#dbeafe";
        ctx.font = "16px monospace";
        ctx.fillText("Retry dashboard", 10, 28);
        ctx.fillText("503 · attempt 2", 10, 56);
        const png = await new Promise<Blob | null>((resolve) => fixture.toBlob(resolve, "image/png"));
        if (!png) throw new Error("Cannot encode the clipboard fixture.");
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([png], "dashboard.png", { type: png.type }));
        field.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    const preview = page.locator(".composer .comment-images img");
    await preview.waitFor();
    await preview.evaluate((image: HTMLImageElement) => image.decode());
    await shot("comment");
    await page.getByRole("button", { name: "Remove attached image 1" }).click();

    await page.keyboard.press("Escape");
    await nav(page, "overview");
    await fitHeight(page, 1700);
    await shot("overview");

    await nav(page, "lessons");
    await fitHeight(page, 700);
    await shot("lessons");

    // The pending scope is its own review of what is not committed yet. Switch back so the next theme starts on the full review.
    await page.locator('#side [data-action="scope"][data-scope="pending"]').click();
    await page.locator('#side [data-scope="pending"][aria-pressed="true"]:not([disabled])').waitFor();
    await nav(page, "file", "src/http/retry.ts");
    await fitHeight(page, 600);
    await shot("pending");
    await page.locator('#side [data-action="scope"][data-scope="all"]').click();
    await page.locator('#side [data-scope="all"][aria-pressed="true"]:not([disabled])').waitFor();

    const fitDialog = async () => {
        await page.setViewportSize({ width: WIDTH, height: 1700 });
        const height = await page.locator("#dialog .modal").evaluate((modal) => modal.scrollHeight);
        await page.setViewportSize({ width: WIDTH, height: height + 64 });
        await page.waitForTimeout(250);
    };
    const openSettingsMenu = async () => {
        const menu = page.locator("#top details.review-settings-menu");
        if (await menu.getAttribute("open") === null) await menu.locator("summary").click();
    };
    await openSettingsMenu();
    await page.locator('#top [data-action="agent-review-configure"]').click();
    await page.locator('#dialog select[name="review-focus"]').selectOption("both");
    await page.locator('#dialog input[name="review-skill"]').first().waitFor({ state: "attached" });
    if (await page.locator('#dialog [data-action="agent-review-start"]').count()) throw new Error("Settings must not start a review.");
    await fitDialog();
    await shot("agent-review");
    await page.locator('#dialog [data-action="review-tab"][data-tab="skills"]').click();
    await fitDialog();
    if (await page.locator('#dialog input[name="review-skill"]:not(:checked)').count()) throw new Error("Bundled skills are on by default.");
    if (await page.locator('#dialog input[name="review-skill-defaults"]').isChecked()) {
        throw new Error("Skill defaults must remain an explicit opt-in.");
    }
    const skills = await page.locator("#dialog .review-skills-section").boundingBox();
    if (!skills) throw new Error("Bundled skills section is not visible.");
    await shot("review-skills", { x: Math.max(0, skills.x - 16), y: Math.max(0, skills.y - 16), width: Math.ceil(skills.width + 32), height: Math.ceil(skills.height + 32) });
    await page.locator('#dialog [data-action="dialog-cancel"]').click();
    await page.locator("#dialog .modal").waitFor({ state: "detached" });

    // A separate page injects a scripted agentic review into the state it loads, so later shots keep the real review.
    if (!only || only.includes("agent-activity")) {
        const activity = await context.newPage();
        let extraRuns = 0;
        await activity.route("**/api/state", async (route) => {
            const response = await route.fetch();
            const json = await response.json() as { review: Parameters<typeof demoAgentRuns>[0] & { agentReviews?: unknown[] } };
            const runs = demoAgentRuns(json.review);
            json.review.agentReviews = [...runs, ...Array.from({ length: extraRuns }, (_, i) => ({
                ...runs[1], runId: `demo-extra-${i}`,
            }))];
            await route.fulfill({ response, json });
        });
        await activity.setViewportSize({ width: WIDTH, height: 760 });
        await activity.goto(url);
        await activity.locator("#side .nav-item").first().waitFor();
        await nav(activity, "agent-comments");
        const toggle = activity.locator('#top [data-action="agent-activity-toggle"]');
        await toggle.filter({ hasText: "Agentic review running" }).waitFor();
        await toggle.click();
        const panel = activity.locator("#agent-activity-panel");
        await panel.waitFor();
        await panel.locator("text=Active · 1 of 3 reported").waitFor();
        if (!await panel.evaluate((element) => element === document.activeElement)) throw new Error("Opening the activity panel must focus it.");
        await activity.mouse.move(0, 0);
        await activity.waitForTimeout(250);
        await shot("agent-activity", undefined, activity);
        await activity.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        const pageToggle = activity.locator('#main [data-action="agent-activity-toggle"]');
        await pageToggle.click();
        await panel.waitFor();
        for (const trigger of [toggle, pageToggle]) assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        await activity.keyboard.press("Escape");
        assert.equal(await pageToggle.evaluate((element) => element === document.activeElement), true);
        for (const trigger of [toggle, pageToggle]) assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        await activity.setViewportSize({ width: WIDTH, height: 280 });
        extraRuns = 6;
        notifyReviewChanged();
        await activity.locator('#agent-activity-layer [data-run="demo-extra-5"]').first().waitFor({ state: "attached" });
        await activity.addStyleTag({ content: '#main .agent-review-launch { position: fixed; top: 195px; right: 8px }' });
        await pageToggle.click();
        const footer = await panel.locator(".agent-activity-footer").boundingBox();
        assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= 280, "the footer fits inside a short viewport");
        const body = panel.locator(".agent-activity-body");
        const offset = await body.evaluate((el) => { el.scrollTop = 72; return el.scrollTop; });
        assert.ok(offset > 0);
        extraRuns++;
        notifyReviewChanged();
        await panel.locator('[data-run="demo-extra-6"]').first().waitFor({ state: "attached" });
        assert.equal(await body.evaluate((el) => el.scrollTop), offset, "new activity rows preserve the scrolled list");
        await activity.unrouteAll({ behavior: "wait" });
        await activity.close();
    }

    // The per-repository settings: switch delivery to Batch before saving.
    await page.setViewportSize({ width: WIDTH, height: 1200 });
    await openSettingsMenu();
    await page.locator('#top [data-action="configure"]').click();
    await page.locator("#dialog .modal").waitFor();
    const modal = await page.locator("#dialog .modal").boundingBox();
    if (!modal) throw new Error("Repository settings dialog is not visible.");
    await page.setViewportSize({ width: WIDTH, height: Math.ceil(modal.height + 64) });
    await page.waitForTimeout(250);
    await page.locator('#dialog input[name="delivery"][value="batch"]').check();
    await shot("configure");
    await page.locator('#dialog [data-action="dialog-save"]').click();
    await page.locator("#dialog .modal").waitFor({ state: "detached" });
    await page.locator("#toast").waitFor({ state: "hidden" });

    // In batch mode comments wait as drafts until Submit review sends them in one message.
    await nav(page, "file", "test/client.test.ts");
    const composeOn = async (needle: string, body: string) => {
        await page.locator("tr.row", { hasText: needle }).first().locator("td.ln").nth(1).hover();
        await page.mouse.down();
        await page.mouse.up();
        const composer = page.locator("textarea[data-composer^='line:']");
        await composer.waitFor();
        await composer.focus();
        await page.keyboard.type(body);
    };
    const drafts = page.locator('[data-action="discard-draft"]');
    for (const [needle, body] of [
        ["retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },", "Use `maxAttempts: 3` so one test can cover more than a single retry."],
        ['.mockResolvedValueOnce(new Response("busy", { status: 503 }))', "Add the 429 case with `Retry-After: 1`, so the header path is covered end to end."],
    ]) {
        const before = await drafts.count();
        await composeOn(needle, body);
        await page.locator(`.composer button[data-draft="1"][data-key^="line:"]`).click();
        await page.waitForFunction((n) => document.querySelectorAll('[data-action="discard-draft"]').length > n, before);
    }
    await page.waitForTimeout(1700); // let the new-thread highlight fade
    await composeOn('new Response("nope", { status: 404 })', "Also assert that a 404 is not retried: `fetch` is called once.");
    await fitHeight(page, 1500);
    await shot("batch");
    await page.keyboard.press("Escape");
    while (await drafts.count()) {
        const before = await drafts.count();
        await drafts.first().click();
        await page.waitForFunction((n) => document.querySelectorAll('[data-action="discard-draft"]').length < n, before);
    }

    await context.close();
}

async function captureImages(browser: Browser, url: string, theme: "light" | "dark") {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator("#side .nav-item").first().waitFor();
    await page.locator("#banner:not([hidden])").waitFor();
    await page.locator('#banner [data-action="learning-set"][data-enabled="false"]').click();
    await page.locator("#banner").waitFor({ state: "hidden" });
    await page.locator("#toast").waitFor({ state: "hidden" });
    // Every visible preview must decode; a block that only rendered its fallback fails here.
    const decoded = async (count: number) => {
        const images = page.locator(".image-diff img[data-image-key]");
        await page.waitForFunction((n) => {
            const shown = [...document.querySelectorAll<HTMLImageElement>(".image-diff img[data-image-key]")];
            return shown.length === n && shown.every((image) => image.complete && image.naturalWidth > 0);
        }, count);
        return images;
    };
    const selectMode = async (mode: string) => {
        await page.locator(`.image-modes [data-action="image-mode"][data-mode="${mode}"]`).click();
        await page.locator(`.image-modes [data-mode="${mode}"][aria-pressed="true"]`).waitFor();
        await decoded(2);
    };

    // An SVG is rendered from a data: URL, never as live markup, and its text diff stays below the preview.
    await nav(page, "file", "assets/logo.svg");
    const logos = await decoded(2);
    for (const src of await logos.evaluateAll((images: HTMLImageElement[]) => images.map((image) => image.src))) {
        assert.match(src, /^data:image\/svg\+xml;base64,/);
    }
    assert.ok(await page.locator(".file-section .diff tr.row.add").count(), "the SVG keeps its text diff");

    await nav(page, "file", "assets/usage-chart.png");
    await decoded(2);
    assert.equal(await page.locator(".image-diff .image-meta").count(), 2, "both sides show dimensions and size");
    await selectMode("onion");
    await page.locator('.image-diff input[data-image-control="opacity"]').waitFor();
    await selectMode("swipe");
    await page.locator('.image-diff input[data-image-control="split"]').waitFor();
    await fitHeight(page, 1000);
    if (!only || only.includes("image-diff")) {
        const target = path.join(OUT, `image-diff-${theme}.png`);
        await page.screenshot({ path: target });
        console.log(`  ${path.relative(process.cwd(), target)}`);
    }
    await selectMode("2-up");
    await context.close();
}

// Add the finding after capturing the other views so it doesn't change their screenshots.
async function checkFindingLayout(browser: Browser, url: string, service: ReviewServiceContract, reviewId: string) {
    const { repoRoot } = await service.getReview(reviewId);
    const filePath = "src/orders/integrations/http/retry/policies/transient-failure-backoff-policy.ts";
    await writeFiles(repoRoot, { [filePath]: "export const maxAttempts = 4;\n" });
    await service.refresh(reviewId);
    const { threadId } = await service.store.updateReview(reviewId, async (review) => {
        assert.ok(review?.currentRevisionId);
        const body = "Clamp the delay to the configured maximum.";
        const { thread } = await service.buildThread(review, { kind: "file", path: filePath, body, author: "agent" });
        const evidence = { source: filePath, baseline: "Missing clamp", validation: "Regression test" };
        thread.status = "resolved";
        thread.agentReview = {
            runId: "demo-layout", revisionId: review.currentRevisionId, model: "gpt-6.2-sol",
            category: "issue", assessment: "confirmed", severity: "required", evidence,
            contributions: ["gpt-6.2-sol", "gpt-6.2-astra"].map((model) => ({ model, body, evidence })),
        };
        review.threads.push(thread);
        return { review, value: thread };
    });

    for (const theme of THEMES) {
        const page = await browser.newPage({ colorScheme: theme });
        try {
            for (const width of [420, WIDTH]) {
                await page.setViewportSize({ width, height: 900 });
                await page.goto(url);
                await nav(page, "agent-comments");
                const card = page.locator(`#main .thread[data-thread-id="${threadId}"]`);
                await card.locator('[data-action="toggle"][aria-expanded="false"]').click();
                const header = card.locator(".thread-head");
                const link = header.getByRole("button", { name: filePath, exact: true });
                const [loc, head] = await Promise.all([link.boundingBox(), header.boundingBox()]);
                assert.ok(loc && head && loc.width >= Math.min(head.width - 24, 180), `width ${width}: keep the path readable`);
                assert.ok(await header.evaluate(el => el.scrollWidth <= el.clientWidth), `width ${width}: no horizontal overflow`);
                const buttons = card.locator(".finding-actions button");
                assert.deepEqual(await buttons.allTextContents(), ["Approve", "Discuss", "Reactivate"]);
                if (width === WIDTH) {
                    const tops = await buttons.evaluateAll(els => els.map(el => el.getBoundingClientRect().top));
                    assert.ok(tops.every(top => top === tops[0]), "keep actions on one row when space permits");
                }
                assert.ok(await buttons.nth(0).isDisabled());
                await card.locator(".finding-evidence summary").focus();
                for (const next of [buttons.nth(1), buttons.nth(2), card.getByPlaceholder("Reply…")]) {
                    await page.keyboard.press("Tab");
                    assert.ok(await next.evaluate(el => el === document.activeElement), "Tab skips Approve and reaches Reply after Reactivate");
                }
                await link.click();
                await page.locator(`.file-section[data-file="${filePath}"] [data-thread-id="${threadId}"]`).waitFor();
            }
        } finally {
            await page.close();
        }
    }
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "mr-shots-"));
let server: Awaited<ReturnType<typeof startReviewServer>> | undefined;
let browser: Browser | undefined;
try {
    const seeded = await seed(tmp);
    if (CHECK_SEED) {
        console.log("Screenshot fixture lessons saved.");
    } else {
        const { service, delivery } = seeded;
        const imageReviewId = await seedImages(tmp, service);
        const extensionVersion = parseExtensionVersion(JSON.parse(await readFile(EXTENSION_VERSION_PATH, "utf8")) as unknown);
        let reviewId = seeded.reviewId;
        const settings = new SettingsService({ store: seeded.store });
        const reviewSkills = new ReviewSkills({ store: seeded.store });
        const agentReview = new AgentReview({ service, settings, reviewSkills, sessionId: () => undefined, send: async () => {
            throw new Error("The screenshot fixture cannot dispatch agent reviews.");
        } });
        // Every theme starts like a first run: the repository has no learning setting yet.
        const resetLearning = () => rm(seeded.store.settingsFile(), { force: true });
        server = await startReviewServer({
            instanceId: "screenshots",
            getReviewId: () => reviewId,
            onReviewChange: (id: string) => {
                reviewId = id;
            },
            service,
            delivery,
            extensionVersion,
            settings,
            agentReview,
            reviewSkills,
            webRoot: WEB_ROOT,
            // The demo repository has no GitHub remote; without this the header would depend on the local gh setup.
            findPullRequest: async () => null,
        });
        await mkdir(OUT, { recursive: true });
        browser = await launchBrowser();
        if (CHECK_REFRESH) {
            await checkRefreshLayout(browser, server.url);
            console.log("Refresh layout stable during progress, error, and retry.");
        } else {
            for (const theme of THEMES) {
                console.log(`${theme}:`);
                await capture(browser, server.url, theme, resetLearning, () => service.changed(seeded.reviewId, "agent-review"));
                if ((await service.getReview(seeded.reviewId)).agentReviews?.length) throw new Error("Screenshots must not start reviews.");
                reviewId = imageReviewId;
                await captureImages(browser, server.url, theme);
                reviewId = seeded.reviewId;
            }
            if (!only || only.includes("agent-comment-layout")) await checkFindingLayout(browser, server.url, service, reviewId);
        }
        if (KEEP) {
            console.log(`\nDemo review: ${server.url}\nRepo: ${path.join(tmp, "orders-api")}\nPress Ctrl+C to stop.`);
            await new Promise(() => {});
        }
    }
} finally {
    await browser?.close();
    await server?.close();
    await rm(tmp, { recursive: true, force: true });
}
