import { createSettingsApi } from "../web/settings-api.mjs";
import { reviewOptions } from "../web/contracts.mjs";

// Compile-only regression checks: each expected error must remain an error.
/** @param {import("../types/contracts.js").SettingsTransport} request @param {unknown} raw */
function contracts(request, raw) {
    const api = createSettingsApi(request);
    api.update({ learning: "suggest", delivery: "ask", dismissed: false });
    api.updateAgentReview({ models: ["model-a"], focus: "both", intent: "", skipDialog: false });
    api.updateAgentReview(null);
    // @ts-expect-error Unknown learning modes must not enter the UI/server contract.
    api.update({ learning: "always" });
    // @ts-expect-error A checkbox value is a boolean, never a truthy string.
    api.updateAgentReview({ models: ["model-a"], focus: "both", intent: "", skipDialog: "false" });
    // @ts-expect-error The defaults endpoint requires its own request envelope.
    request("POST", "agent-review-settings", { learning: "off" });
    // @ts-expect-error Delivery selection is not a learning mode.
    request("POST", "settings", { learning: "batch" });
    /** @type {import("../types/contracts.js").RepoSettings} */
    // @ts-expect-error Raw network JSON must be decoded before reading settings.
    const response = raw;
    return response;
}

const options = reviewOptions({ models: ["model-a"], focus: "both" });
// @ts-expect-error The actual validator must return a narrow focus, not any/string.
options.focus = "unsupported";
