import { isRecord } from "../web/contracts.mjs";
export class HttpError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.status = status;
        this.code = code;
    }
}
export class SettingsHttp {
    settings;
    log;
    constructor(settings, log) {
        this.settings = settings;
        this.log = log;
    }
    async read(repoRoot) {
        const state = { settings: null, agentReviewSettings: null, agentReviewSettingsAvailable: Boolean(this.settings?.getAgentReview) };
        if (!this.settings)
            return state;
        state.settings = await this.repo(repoRoot);
        if (!this.settings.getAgentReview)
            return state;
        try {
            state.agentReviewSettings = await this.settings.getAgentReview();
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log(`self-review: could not read agent review defaults: ${message}`, "warning");
            state.agentReviewSettingsError = `Could not read agent review defaults: ${message}`;
        }
        return state;
    }
    async repo(repoRoot) {
        if (!this.settings)
            return null;
        try {
            return await this.settings.get(repoRoot);
        }
        catch (err) {
            this.log(`self-review: could not read settings: ${err instanceof Error ? err.message : String(err)}`, "warning");
            return null;
        }
    }
    async update(repoRoot, body) {
        if (!this.settings)
            throw new HttpError(501, "unsupported", "Settings are not available.");
        return this.settings.update(repoRoot, body);
    }
    async updateAgentReview(body) {
        if (!this.settings?.updateAgentReview)
            throw new HttpError(501, "unsupported", "Agent review defaults are not available.");
        return this.settings.updateAgentReview(isRecord(body) ? body.defaults : undefined);
    }
}
