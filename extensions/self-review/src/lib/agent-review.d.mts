import type { SettingsService } from "./settings.mjs";
import type { ReviewService } from "./review-service.mjs";
import type { Log } from "../../types/contracts.js";

type CopilotSession = Awaited<ReturnType<typeof import("@github/copilot-sdk/extension").joinSession>>;
type SendOptions = Parameters<CopilotSession["send"]>[0];

export class AgentReview {
    constructor(options: {
        service: ReviewService;
        settings: SettingsService;
        send: (options: SendOptions) => Promise<string>;
        sessionId: () => string | undefined;
        log: Log;
    });
    recover(reviewId: string): Promise<void>;
    start(reviewId: string, input: unknown, instanceId: string): Promise<unknown>;
    input(reviewId: string, input: unknown): Promise<unknown>;
    report(reviewId: string, input: unknown): Promise<unknown>;
    close(reviewId: string, runId: string): Promise<unknown>;
    approve(reviewId: string, findingId: string, revisionId?: string): Promise<{ threadId: string; messageId: string }>;
}

export const REVIEW_FOCUSES: string[];
export const FINDING_ASSESSMENTS: string[];
export const FINDING_SEVERITIES: string[];
export const EVIDENCE_FIELDS: string[];
export const FUSION_REVIEWER: string;
export const SUGGESTED_REVIEWERS: string[];
