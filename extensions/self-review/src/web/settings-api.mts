import { agentReviewDefaults, repoSettings, settingsPatch, settingsState } from "./contracts.mjs";
import type { SettingsRequests, SettingsResponses, SettingsTransport } from "../../types/contracts.js";

// The transport owns authentication and HTTP errors. Only the settings portion of /state is decoded here.
export function createSettingsApi(request: SettingsTransport) {
    return {
        readState: settingsState,
        async update(patch: SettingsRequests["settings"]): Promise<SettingsResponses["settings"]> {
            const body = settingsPatch(patch);
            return repoSettings(await request("POST", "settings", body));
        },
        async updateAgentReview(defaults: SettingsRequests["agent-review-settings"]["defaults"]): Promise<SettingsResponses["agent-review-settings"]> {
            const body = { defaults: defaults === null ? null : agentReviewDefaults(defaults) };
            const result = await request("POST", "agent-review-settings", body);
            return result === null ? null : agentReviewDefaults(result);
        },
    };
}
