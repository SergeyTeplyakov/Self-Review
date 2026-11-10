import { createSettingsApi } from "../src/web/settings-api.mjs";
import { reviewOptions } from "../src/web/contracts.mjs";
import type { RepoSettings, SettingsTransport } from "../types/contracts.js";

// Compile-only regression checks: each expected error must remain an error.
function contracts(request: SettingsTransport, raw: unknown) {
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
    // @ts-expect-error Raw network JSON must be decoded before reading settings.
    const response: RepoSettings = raw;
    return response;
}

const options = reviewOptions({ models: ["model-a"], focus: "both" });
// @ts-expect-error The actual validator must return a narrow focus, not any/string.
options.focus = "unsupported";
