// @ts-check
import type {
    AgentReviewDefaults,
    AgentReviewOptions,
    DeliveryChoice,
    DeliveryMode,
    InstructionMapping,
    RepoSettings,
    SettingsDocument,
    SettingsPatch,
    SettingsState,
    StoredRepoSettings,
} from "../../types/contracts.js";

// Runtime guards are still required: disk, HTTP, and SDK inputs are not trusted by types.
export class ReviewError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

export const DELIVERY_MODES: DeliveryMode[] = ["immediate", "batch", "ask"];
export const COMMENT_CONCURRENCIES = [1, 2, 3, 4] as const;
export function isCommentConcurrency(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= COMMENT_CONCURRENCIES.length;
}
export const REVIEW_FOCUSES: import("../../types/contracts.js").ReviewFocus[] = ["review", "simplify", "both"];
export const FUSION_REVIEWER = "copilot-fusion";
export const SUGGESTED_REVIEWERS = ["mai-code-2", "gpt-6.2-sol", "gpt-6.2-astra"];

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isDeliveryMode(value: unknown): value is DeliveryMode {
    return value === "immediate" || value === "batch" || value === "ask";
}

function repoRelativePath(value: unknown, name: string): string {
    if (typeof value !== "string" || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)
        || /[\u0000-\u001f]/.test(value) || value.split("/").some((part) => part === "." || part === "..")) {
        throw new ReviewError("invalid_input", `${name} must be a repository-relative path without traversal.`);
    }
    return value.replace(/\/+$/, "");
}

function parseInstructionMappings(value: unknown): InstructionMapping[] {
    if (!Array.isArray(value) || value.length > 100) {
        throw new ReviewError("invalid_input", "instructionMappings must be an array of at most 100 mappings.");
    }
    const mappings = value.map((mapping: unknown) => {
        if (!isRecord(mapping) || typeof mapping.splitLanguageSpecific !== "boolean") {
            throw new ReviewError("invalid_input", "Each instruction mapping requires a splitLanguageSpecific boolean.");
        }
        return {
            pathPrefix: repoRelativePath(mapping.pathPrefix, "pathPrefix"),
            instructionRoot: repoRelativePath(mapping.instructionRoot, "instructionRoot"),
            splitLanguageSpecific: mapping.splitLanguageSpecific,
        };
    });
    if (new Set(mappings.map((mapping) => mapping.pathPrefix)).size !== mappings.length) {
        throw new ReviewError("invalid_input", "Instruction mapping path prefixes must be unique.");
    }
    return mappings;
}

export function reviewOptions(input: unknown): AgentReviewOptions {
    if (!isRecord(input) || !Array.isArray(input.models) || input.models.length < 1 || input.models.length > 4) {
        throw new ReviewError("invalid_input", `Choose one to four distinct reviewers: exact model IDs or ${FUSION_REVIEWER}.`);
    }
    const models = input.models;
    if (!models.every((model: unknown): model is string => typeof model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model))
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
        || !input.skillNames.every((name: unknown): name is string => typeof name === "string" && Boolean(name.trim()) && name.length <= 240)
        || new Set(input.skillNames).size !== input.skillNames.length)) {
        throw new ReviewError("invalid_input", "skillNames must contain up to three distinct bundled review skill names.");
    }
    return { models: [...models], focus: input.focus, intent: typeof input.intent === "string" ? input.intent.trim() : "",
        ...(input.skillNames !== undefined ? { skillNames: [...input.skillNames] } : {}) };
}

export function agentReviewDefaults(defaults: unknown): AgentReviewDefaults {
    if (!isRecord(defaults) || typeof defaults.skipDialog !== "boolean") {
        throw new ReviewError("invalid_input", "Agent review defaults require models, focus, and a boolean skipDialog.");
    }
    const { skillNames: _skillNames, ...options } = reviewOptions(defaults);
    return { ...options, skipDialog: defaults.skipDialog };
}

export function settingsPatch(value: unknown): SettingsPatch {
    if (!isRecord(value) || (value.autoSaveLearnedRules === undefined && value.delivery === undefined
        && value.commentConcurrency === undefined && value.dismissed === undefined && value.instructionMappings === undefined)) {
        throw new ReviewError("invalid_input", "Provide autoSaveLearnedRules, delivery, commentConcurrency, dismissed, or instructionMappings.");
    }
    if (value.autoSaveLearnedRules !== undefined && typeof value.autoSaveLearnedRules !== "boolean") {
        throw new ReviewError("invalid_input", "autoSaveLearnedRules must be a boolean.");
    }
    if (value.delivery !== undefined && !isDeliveryMode(value.delivery)) {
        throw new ReviewError("invalid_input", `delivery must be one of ${DELIVERY_MODES.join(", ")}.`);
    }
    if (value.dismissed !== undefined && typeof value.dismissed !== "boolean") {
        throw new ReviewError("invalid_input", "dismissed must be a boolean.");
    }
    if (value.expectedInstructionMappings !== undefined && value.instructionMappings === undefined) {
        throw new ReviewError("invalid_input", "expectedInstructionMappings requires instructionMappings.");
    }
    if (value.commentConcurrency !== undefined && !isCommentConcurrency(value.commentConcurrency)) {
        throw new ReviewError("invalid_input", "commentConcurrency must be an integer from 1 to 4.");
    }
    return {
        autoSaveLearnedRules: value.autoSaveLearnedRules, delivery: value.delivery, dismissed: value.dismissed,
        ...(value.commentConcurrency !== undefined ? { commentConcurrency: value.commentConcurrency } : {}),
        instructionMappings: value.instructionMappings === undefined ? undefined : parseInstructionMappings(value.instructionMappings),
        expectedInstructionMappings: value.expectedInstructionMappings === undefined
            ? undefined
            : parseInstructionMappings(value.expectedInstructionMappings),
    };
}

export function settingsDocument(value: unknown): SettingsDocument {
    if (value === null) return { version: 1, repos: {} };
    if (!isRecord(value) || (value.version !== undefined && typeof value.version !== "number")) {
        throw new Error("Invalid settings document.");
    }
    if (value.repos !== undefined && !isRecord(value.repos)) throw new Error("Invalid settings repositories.");
    const repos = new Map<string, StoredRepoSettings>();
    for (const [key, entry] of Object.entries(value.repos ?? {})) {
        if (!isRecord(entry)
            || (entry.name !== undefined && typeof entry.name !== "string")
            || (entry.updatedAt !== undefined && typeof entry.updatedAt !== "string")) {
            throw new Error(`Invalid settings for repository ${key}.`);
        }
        if (entry.instructionMappings !== undefined) {
            try {
                entry.instructionMappings = parseInstructionMappings(entry.instructionMappings);
            } catch (error) {
                throw new Error(`Invalid instruction mappings for repository ${key}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        repos.set(key, entry);
    }
    return { ...value, version: value.version, repos: Object.fromEntries(repos) };
}

export function repoSettings(value: unknown): RepoSettings {
    if (!isRecord(value) || typeof value.repoName !== "string"
        || typeof value.autoSaveLearnedRules !== "boolean" || !isDeliveryMode(value.delivery)
        || typeof value.configured !== "boolean" || typeof value.dismissed !== "boolean"
        || (value.pathCaseSensitive !== undefined && typeof value.pathCaseSensitive !== "boolean")
        || (value.commentConcurrency !== undefined && !isCommentConcurrency(value.commentConcurrency))) {
        throw new Error("Invalid repository settings response.");
    }
    const instructionMappings = value.instructionMappings === undefined ? [] : parseInstructionMappings(value.instructionMappings);
    return {
        repoName: value.repoName, autoSaveLearnedRules: value.autoSaveLearnedRules, delivery: value.delivery,
        instructionMappings,
        ...(value.pathCaseSensitive !== undefined ? { pathCaseSensitive: value.pathCaseSensitive } : {}),
        configured: value.configured, dismissed: value.dismissed,
        ...(value.commentConcurrency !== undefined ? { commentConcurrency: value.commentConcurrency } : {}),
    };
}

export function settingsState(value: unknown): SettingsState {
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
