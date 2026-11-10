import { agentReviewDefaults, repoSettings, settingsPatch, settingsState } from "./contracts.mjs";
// The transport owns authentication and HTTP errors. Only the settings portion of /state is decoded here.
export function createSettingsApi(request) {
    return {
        readState: settingsState,
        async update(patch) {
            const body = settingsPatch(patch);
            return repoSettings(await request("POST", "settings", body));
        },
        async updateAgentReview(defaults) {
            const body = { defaults: defaults === null ? null : agentReviewDefaults(defaults) };
            const result = await request("POST", "agent-review-settings", body);
            return result === null ? null : agentReviewDefaults(result);
        },
    };
}
