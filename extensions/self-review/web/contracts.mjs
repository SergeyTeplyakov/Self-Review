// @ts-check
// Runtime guards are still required: disk, HTTP, and SDK inputs are not trusted by JSDoc.
export class ReviewError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/** @typedef {import("../types/contracts.js").LearningMode} LearningMode */
/** @typedef {import("../types/contracts.js").DeliveryMode} DeliveryMode */

/** @type {LearningMode[]} */
export const LEARNING_MODES = ["off", "suggest", "auto"];
/** @type {DeliveryMode[]} */
export const DELIVERY_MODES = ["immediate", "batch", "ask"];
/** @type {import("../types/contracts.js").ReviewFocus[]} */
export const REVIEW_FOCUSES = ["review", "simplify", "both"];
export const FUSION_REVIEWER = "copilot-fusion";
export const SUGGESTED_REVIEWERS = ["gpt-6-astra", "gpt-6.1-sol", FUSION_REVIEWER];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is LearningMode} */
export function isLearningMode(value) {
    return value === "off" || value === "suggest" || value === "auto";
}

/** @param {unknown} value @returns {value is DeliveryMode} */
export function isDeliveryMode(value) {
    return value === "immediate" || value === "batch" || value === "ask";
}

/** @param {unknown} input @returns {import("../types/contracts.js").AgentReviewOptions} */
export function reviewOptions(input) {
    if (!isRecord(input) || !Array.isArray(input.models) || input.models.length < 1 || input.models.length > 4
        || !input.models.every((m) => typeof m === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(m))
        || new Set(input.models).size !== input.models.length) {
        throw new ReviewError("invalid_input", `Choose one to four distinct reviewers: exact model IDs or ${FUSION_REVIEWER}.`);
    }
    if (input.focus !== "review" && input.focus !== "simplify" && input.focus !== "both") {
        throw new ReviewError("invalid_input", "focus must be review, simplify, or both.");
    }
    if (input.intent !== undefined && (typeof input.intent !== "string" || input.intent.length > 4000)) {
        throw new ReviewError("invalid_input", "intent must be text (up to 4000 characters).");
    }
    return { models: [...input.models], focus: input.focus, intent: input.intent?.trim() ?? "" };
}

/** @param {unknown} defaults @returns {import("../types/contracts.js").AgentReviewDefaults} */
export function agentReviewDefaults(defaults) {
    if (!isRecord(defaults) || typeof defaults.skipDialog !== "boolean") {
        throw new ReviewError("invalid_input", "Agent review defaults require models, focus, and a boolean skipDialog.");
    }
    return { ...reviewOptions(defaults), skipDialog: defaults.skipDialog };
}

/** @param {unknown} value @returns {import("../types/contracts.js").SettingsPatch} */
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

/** @param {unknown} value @returns {import("../types/contracts.js").SettingsDocument} */
export function settingsDocument(value) {
    if (value === null) return { version: 1, repos: {} };
    if (!isRecord(value) || (value.version !== undefined && typeof value.version !== "number")) {
        throw new Error("Invalid settings document.");
    }
    if (value.repos !== undefined && !isRecord(value.repos)) throw new Error("Invalid settings repositories.");
    /** @type {Map<string, import("../types/contracts.js").StoredRepoSettings>} */
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

/** @param {unknown} value @returns {import("../types/contracts.js").RepoSettings} */
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

/** @param {unknown} value @returns {import("../types/contracts.js").SettingsState} */
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
