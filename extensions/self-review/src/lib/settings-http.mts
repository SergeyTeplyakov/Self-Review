import { isRecord } from "../web/contracts.mjs";
import type { AgentReviewDefaults, Log, RepoSettings, SettingsState } from "../../types/contracts.js";
import type { SettingsService } from "./settings.mjs";

export class HttpError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export class SettingsHttp {
    constructor(private readonly settings: SettingsService | undefined, private readonly log: Log) {}

    async read(repoRoot: string): Promise<SettingsState> {
        const state: SettingsState = { settings: null, agentReviewSettings: null, agentReviewSettingsAvailable: Boolean(this.settings?.getAgentReview) };
        if (!this.settings) return state;
        state.settings = await this.repo(repoRoot);
        if (!this.settings.getAgentReview) return state;
        try {
            state.agentReviewSettings = await this.settings.getAgentReview();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log(`self-review: could not read agent review defaults: ${message}`, "warning");
            state.agentReviewSettingsError = `Could not read agent review defaults: ${message}`;
        }
        return state;
    }

    async repo(repoRoot: string): Promise<RepoSettings | null> {
        if (!this.settings) return null;
        try {
            return await this.settings.get(repoRoot);
        } catch (err) {
            this.log(`self-review: could not read settings: ${err instanceof Error ? err.message : String(err)}`, "warning");
            return null;
        }
    }

    async update(repoRoot: string, body: unknown): Promise<RepoSettings> {
        if (!this.settings) throw new HttpError(501, "unsupported", "Settings are not available.");
        return this.settings.update(repoRoot, body);
    }

    async updateAgentReview(body: unknown): Promise<AgentReviewDefaults | null> {
        if (!this.settings?.updateAgentReview) throw new HttpError(501, "unsupported", "Agent review defaults are not available.");
        return this.settings.updateAgentReview(isRecord(body) ? body.defaults : undefined);
    }
}
