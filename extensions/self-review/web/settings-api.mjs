import { agentReviewDefaults, repoSettings, settingsPatch, settingsState } from "./contracts.mjs";

/** @typedef {import("../types/contracts.js").SettingsRequests} SettingsRequests */
/** @typedef {import("../types/contracts.js").SettingsResponses} SettingsResponses */

/**
 * The transport owns authentication, scope-switch headers, and HTTP error handling.
 * Only the settings portion of /state is decoded here; the renderer remains unchecked.
 * @param {import("../types/contracts.js").SettingsTransport} request
 */
export function createSettingsApi(request) {
    return {
        readState: settingsState,
        /** @param {SettingsRequests["settings"]} patch @returns {Promise<SettingsResponses["settings"]>} */
        async update(patch) {
            const body = settingsPatch(patch);
            return repoSettings(await request("POST", "settings", body));
        },
        /** @param {SettingsRequests["agent-review-settings"]["defaults"]} defaults
         * @returns {Promise<SettingsResponses["agent-review-settings"]>} */
        async updateAgentReview(defaults) {
            const body = { defaults: defaults === null ? null : agentReviewDefaults(defaults) };
            const result = await request("POST", "agent-review-settings", body);
            return result === null ? null : agentReviewDefaults(result);
        },
    };
}
