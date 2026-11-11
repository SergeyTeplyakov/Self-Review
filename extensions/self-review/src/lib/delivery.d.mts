import { EventEmitter } from "node:events";
import type { Log } from "../../types/contracts.js";
import type { ReviewService } from "./review-service.mjs";

type CopilotSession = Awaited<ReturnType<typeof import("@github/copilot-sdk/extension").joinSession>>;
type SendOptions = Parameters<CopilotSession["send"]>[0];
type DeliveryResult = Record<string, unknown> & { submitted: number; error?: string };

export class Delivery extends EventEmitter {
    constructor(options: {
        service: ReviewService;
        log: Log;
        send: (options: SendOptions) => Promise<string>;
        reviewIds: () => Set<string>;
        learning: (repoRoot: string) => Promise<string>;
        sessionId: () => string | undefined;
    });
    readonly busy: boolean | null;
    setBusy(busy: boolean): void;
    onUserMessage(event: unknown): Promise<void>;
    onIdle(): Promise<void>;
    deliver(reviewId: string, threadId: string, messageId: string, instanceId: string, options?: { retry?: boolean }): Promise<Record<string, unknown>>;
    submit(reviewId: string, instanceId: string): Promise<DeliveryResult>;
}
