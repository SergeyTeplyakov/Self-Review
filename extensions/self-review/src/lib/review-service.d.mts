import { EventEmitter } from "node:events";
import type { Log, ReviewScope } from "../../types/contracts.js";
import type { Store } from "./store.mjs";

export class ReviewError extends Error {
    constructor(code: string, message: string);
    code: string;
}

export interface ReviewMessage {
    messageId: string;
    author: "user" | "agent";
    body: string;
    delivery?: { state: string };
    [key: string]: unknown;
}

export interface ReviewThread {
    threadId: string;
    status: string;
    location?: unknown;
    messages?: ReviewMessage[];
    [key: string]: unknown;
}

export interface Review {
    reviewId: string;
    repoRoot: string;
    branch: string | null;
    title: string;
    scope: ReviewScope;
    currentRevisionId: string | null;
    threads: ReviewThread[];
    deliveryMode?: string | null;
    [key: string]: unknown;
}

export class ReviewService extends EventEmitter {
    constructor(options: { store: Store; log?: Log });
    store: Store;
    ensureReview(input: unknown, options: { cwd: string }): Promise<string>;
    getReview(reviewId: string): Promise<Review>;
    getSnapshot(reviewId: string, snapshotId: string): Promise<unknown>;
    getFileContent(reviewId: string, snapshotId: string, filePath: string | null): Promise<unknown>;
    changed(reviewId: string, reason: string): void;
    recoverAbandonedClaims(reviewId: string): Promise<void>;
    summarize(review: Review, options?: { threadId?: string; includeResolved?: boolean; maxBody?: number }): Record<string, unknown>;
    updateDescription(reviewId: string, input: unknown): Promise<unknown>;
    addMessage(reviewId: string, threadId: string, input: unknown): Promise<{ thread: ReviewThread; message: ReviewMessage; duplicate?: boolean }>;
    createThread(reviewId: string, input: unknown): Promise<{ thread: ReviewThread; message: ReviewMessage; duplicate?: boolean }>;
    setThreadStatus(reviewId: string, threadId: string, status: unknown): Promise<ReviewThread>;
    refresh(reviewId: string): Promise<Record<string, unknown>>;
    setDelivery(reviewId: string, messageId: string, update: { state: string; error?: string }): Promise<unknown>;
    findMessage(reviewId: string, messageId: string): Promise<{ thread: ReviewThread; message: ReviewMessage }>;
    discardDraft(reviewId: string, messageId: string): Promise<unknown>;
    setDeliveryChoice(reviewId: string, mode: unknown): Promise<"immediate" | "batch" | null>;
    openSibling(reviewId: string, scope: ReviewScope, input?: { commit?: unknown }): Promise<string>;
}

export const THREAD_KINDS: string[];
export const THREAD_STATUSES: string[];
export const OUTCOMES: string[];
export const LESSON_STATUSES: string[];
export const SCOPES: ReviewScope[];
