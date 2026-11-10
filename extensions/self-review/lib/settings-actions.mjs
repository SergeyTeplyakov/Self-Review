import { REVIEW_FOCUSES, SUGGESTED_REVIEWERS } from "../web/contracts.mjs";

/** @type {import("@github/copilot-sdk/extension").CanvasJsonSchema} */
export const agentReviewSettingsSchema = {
    type: "object",
    properties: {
        models: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 120 } },
        focus: { type: "string", enum: REVIEW_FOCUSES },
        intent: { type: "string", maxLength: 4000 },
        skipDialog: { type: "boolean", description: "An explicit Run agentic review click uses these defaults without reopening configuration. Does not auto-start reviews or authorize fixes." },
    },
    required: ["models", "focus", "skipDialog"],
    additionalProperties: false,
};

/**
 * @param {object} options
 * @param {import("./settings.mjs").SettingsService} options.settings
 * @param {() => void} options.changed
 * @param {(handler: import("@github/copilot-sdk/extension").CanvasAction["handler"]) => import("@github/copilot-sdk/extension").CanvasAction["handler"]} options.guard
 * @returns {import("@github/copilot-sdk/extension").CanvasAction[]}
 */
export function settingsActions({ settings, changed, guard }) {
    return [
        {
            name: "get_agent_review_settings",
            description: `Read this user's agent review defaults across repositories. Null means not configured; the canvas then prefills the built-in suggestions ${SUGGESTED_REVIEWERS.join(", ")}, which are not saved choices or consent. Reading settings does not start a review.`,
            handler: guard(() => settings.getAgentReview()),
        },
        {
            name: "set_agent_review_settings",
            description: "Save user-selected review defaults across repositories, or clear them with defaults:null. Only on the user's explicit configuration request. Never select paid models on the user's behalf.",
            inputSchema: {
                type: "object",
                properties: { defaults: { anyOf: [agentReviewSettingsSchema, { type: "null" }] } },
                required: ["defaults"],
                additionalProperties: false,
            },
            handler: guard(async (ctx) => {
                const input = ctx.input;
                const defaults = input && typeof input === "object" && !Array.isArray(input) ? input.defaults : undefined;
                const saved = await settings.updateAgentReview(defaults);
                changed();
                return saved;
            }),
        },
    ];
}
