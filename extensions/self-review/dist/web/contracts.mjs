// Runtime guards are still required: disk, HTTP, and SDK inputs are not trusted by types.
export class ReviewError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export const LEARNING_MODES = ["off", "suggest", "auto"];
export const DELIVERY_MODES = ["immediate", "batch", "ask"];
export const REVIEW_FOCUSES = ["review", "simplify", "both"];
export const FUSION_REVIEWER = "copilot-fusion";
export const SUGGESTED_REVIEWERS = ["gpt-6-astra", "gpt-6.1-sol", FUSION_REVIEWER];
export function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isLearningMode(value) {
    return value === "off" || value === "suggest" || value === "auto";
}
export function isDeliveryMode(value) {
    return value === "immediate" || value === "batch" || value === "ask";
}
export function reviewOptions(input) {
    if (!isRecord(input) || !Array.isArray(input.models) || input.models.length < 1 || input.models.length > 4) {
        throw new ReviewError("invalid_input", `Choose one to four distinct reviewers: exact model IDs or ${FUSION_REVIEWER}.`);
    }
    const models = input.models;
    if (!models.every((model) => typeof model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model))
        || new Set(models).size !== models.length) {
        throw new ReviewError("invalid_input", `Choose one to four distinct reviewers: exact model IDs or ${FUSION_REVIEWER}.`);
    }
    if (input.focus !== "review" && input.focus !== "simplify" && input.focus !== "both") {
        throw new ReviewError("invalid_input", "focus must be review, simplify, or both.");
    }
    if (input.intent !== undefined && (typeof input.intent !== "string" || input.intent.length > 4000)) {
        throw new ReviewError("invalid_input", "intent must be text (up to 4000 characters).");
    }
    if (input.skillNames !== undefined && (!Array.isArray(input.skillNames) || input.skillNames.length > 3
        || !input.skillNames.every((name) => typeof name === "string" && Boolean(name.trim()) && name.length <= 240)
        || new Set(input.skillNames).size !== input.skillNames.length)) {
        throw new ReviewError("invalid_input", "skillNames must contain up to three distinct installed skill names.");
    }
    return { models: [...models], focus: input.focus, intent: typeof input.intent === "string" ? input.intent.trim() : "",
        ...(input.skillNames !== undefined ? { skillNames: [...input.skillNames] } : {}) };
}
export function agentReviewDefaults(defaults) {
    if (!isRecord(defaults) || typeof defaults.skipDialog !== "boolean") {
        throw new ReviewError("invalid_input", "Agent review defaults require models, focus, and a boolean skipDialog.");
    }
    const { skillNames: _skillNames, ...options } = reviewOptions(defaults);
    return { ...options, skipDialog: defaults.skipDialog };
}
export function settingsPatch(value) {
    if (!isRecord(value) || (value.learning === undefined && value.delivery === undefined && value.dismissed === undefined)) {
        throw new ReviewError("invalid_input", "Provide learning, delivery, or dismissed.");
    }
    if (value.learning !== undefined && !isLearningMode(value.learning)) {
        throw new ReviewError("invalid_input", `learning must be one of ${LEARNING_MODES.join(", ")}.`);
    }
    if (value.delivery !== undefined && !isDeliveryMode(value.delivery)) {
        throw new ReviewError("invalid_input", `delivery must be one of ${DELIVERY_MODES.join(", ")}.`);
    }
    if (value.dismissed !== undefined && typeof value.dismissed !== "boolean") {
        throw new ReviewError("invalid_input", "dismissed must be a boolean.");
    }
    return { learning: value.learning, delivery: value.delivery, dismissed: value.dismissed };
}
export function settingsDocument(value) {
    if (value === null)
        return { version: 1, repos: {} };
    if (!isRecord(value) || (value.version !== undefined && typeof value.version !== "number")) {
        throw new Error("Invalid settings document.");
    }
    if (value.repos !== undefined && !isRecord(value.repos))
        throw new Error("Invalid settings repositories.");
    const repos = new Map();
    for (const [key, entry] of Object.entries(value.repos ?? {})) {
        if (!isRecord(entry)
            || (entry.name !== undefined && typeof entry.name !== "string")
            || (entry.updatedAt !== undefined && typeof entry.updatedAt !== "string")) {
            throw new Error(`Invalid settings for repository ${key}.`);
        }
        repos.set(key, entry);
    }
    return { ...value, version: value.version, repos: Object.fromEntries(repos) };
}
export function repoSettings(value) {
    if (!isRecord(value) || typeof value.repoName !== "string"
        || !isLearningMode(value.learning) || !isDeliveryMode(value.delivery)
        || typeof value.configured !== "boolean" || typeof value.dismissed !== "boolean") {
        throw new Error("Invalid repository settings response.");
    }
    return {
        repoName: value.repoName, learning: value.learning, delivery: value.delivery,
        configured: value.configured, dismissed: value.dismissed,
    };
}
export function settingsState(value) {
    if (!isRecord(value)
        || (value.agentReviewSettingsAvailable !== undefined && typeof value.agentReviewSettingsAvailable !== "boolean")
        || (value.agentReviewSettingsError !== undefined && typeof value.agentReviewSettingsError !== "string")) {
        throw new Error("Invalid settings state response.");
    }
    return {
        settings: value.settings == null ? null : repoSettings(value.settings),
        agentReviewSettings: value.agentReviewSettings == null ? null : agentReviewDefaults(value.agentReviewSettings),
        agentReviewSettingsAvailable: value.agentReviewSettingsAvailable === true,
        agentReviewSettingsError: value.agentReviewSettingsError,
    };
}
