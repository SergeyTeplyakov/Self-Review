import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentReviewDefaults } from "../types/contracts.js";
import type { CanvasJsonSchema } from "@github/copilot-sdk/extension";
import {
    Store, SettingsHttp, SettingsService, agentReviewDefaults, createSettingsApi, resolveDelivery,
    reviewOptions, settingsActions, settingsDocument, settingsPatch,
} from "./modules.mjs";

const defaults = { models: ["model-a", "copilot-fusion"], focus: "both", intent: "Check contracts.", skipDialog: false } satisfies AgentReviewDefaults;
const effective = { repoName: "repo", learning: "suggest", delivery: "ask", configured: true, dismissed: false };

async function fixture(t: import("node:test").TestContext) {
    const root = await mkdtemp(path.join(os.tmpdir(), "sr-contracts-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root);
    const log: string[] = [];
    const settings = new SettingsService({
        store, log: (message) => log.push(message),
        git: { runGit: async () => ({ ok: true, stdout: "https://github.com/owner/repo.git", stderr: "" }) },
    });
    return { store, settings, log };
}

function required<T>(value: T | null | undefined): T {
    assert.ok(value);
    return value;
}

function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

test("shared options and patch codecs reject untrusted input without type assertions", () => {
    assert.deepEqual(reviewOptions(defaults), { models: defaults.models, focus: "both", intent: defaults.intent });
    assert.deepEqual(agentReviewDefaults(defaults), defaults);
    assert.deepEqual(settingsPatch({ learning: "off", dismissed: false }), { learning: "off", delivery: undefined, dismissed: false });
    for (const value of [null, [], {}, { models: ["model-a"], focus: "invalid" }, { ...defaults, models: ["a", "a"] }, { ...defaults, intent: 3 }]) {
        assert.throws(() => reviewOptions(value), (error) => hasCode(error, "invalid_input"));
    }
    for (const value of [undefined, null, [], {}, { learning: "batch" }, { delivery: "auto" }, { dismissed: "false" }]) {
        assert.throws(() => settingsPatch(value), (error) => hasCode(error, "invalid_input"));
    }
    assert.throws(() => agentReviewDefaults({ ...defaults, skipDialog: "false" }), (error) => hasCode(error, "invalid_input"));
    assert.equal(resolveDelivery("ask", { deliveryMode: "batch" }), "batch");
    assert.equal(resolveDelivery("ask", {}), null);
});

test("the saved-settings codec preserves metadata and legacy modes but rejects broken containers", async (t) => {
    const { store, settings, log } = await fixture(t);
    const legacy = { repos: { "remote:github.com/owner/repo": { learning: "unknown", custom: "kept" } }, customRoot: { kept: true } };
    await writeFile(store.settingsFile(), JSON.stringify(legacy));
    const previous = await settings.get("repo");
    assert.equal(previous.learning, "off");
    assert.equal(previous.delivery, "immediate");
    assert.equal(previous.configured, false);
    await settings.update("repo", { delivery: "batch" });
    const saved = JSON.parse(await readFile(store.settingsFile(), "utf8"));
    assert.deepEqual(saved.customRoot, { kept: true });
    assert.equal(saved.repos["remote:github.com/owner/repo"].custom, "kept");
    for (const value of [[], false, { repos: [] }, { repos: { repo: null } }, { repos: { repo: { name: 7 } } }]) {
        assert.throws(() => settingsDocument(value), /Invalid settings/);
    }
    await writeFile(store.settingsFile(), JSON.stringify({ repos: [] }));
    await assert.rejects(() => settings.update("repo", { delivery: "batch" }), /Invalid settings repositories/);
    assert.equal((await settings.get("repo")).learning, "off");
    assert.match(required(log.at(-1)), /settings unreadable/);
    const special = settingsDocument(JSON.parse('{"repos":{"__proto__":{"learning":"off"}}}'));
    assert.equal(Object.hasOwn(special.repos, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(special.repos), Object.prototype);
});

test("checked HTTP and browser settings boundaries round-trip persisted choices", async (t) => {
    const { store, settings, log } = await fixture(t);
    const http = new SettingsHttp(settings, (message) => log.push(message));
    const posts: Array<{ method: string; endpoint: string; body: unknown }> = [];
    const api = createSettingsApi(async (method, endpoint, body) => {
        posts.push({ method, endpoint, body });
        return endpoint === "settings" ? http.update("repo", body) : http.updateAgentReview(body);
    });
    await api.update({ learning: "suggest", delivery: "ask" });
    await api.updateAgentReview(defaults);
    const state = api.readState(await http.read("repo"));
    assert.deepEqual(state.settings, effective);
    assert.deepEqual(state.agentReviewSettings, defaults);
    assert.equal(state.agentReviewSettingsAvailable, true);
    assert.deepEqual(posts.map((p) => p.endpoint), ["settings", "agent-review-settings"]);
    assert.deepEqual(await new SettingsService({ store }).getAgentReview(), defaults);
    assert.equal(await api.updateAgentReview(null), null);
    assert.equal((await http.read("repo")).agentReviewSettings, null);
    await assert.rejects(() => http.updateAgentReview(null), (error) => hasCode(error, "invalid_input"));
    await assert.rejects(() => http.update("repo", []), (error) => hasCode(error, "invalid_input"));
    assert.deepEqual(await new SettingsHttp(undefined, () => {}).read("repo"), {
        settings: null, agentReviewSettings: null, agentReviewSettingsAvailable: false,
    });
    await assert.rejects(() => new SettingsHttp(undefined, () => {}).update("repo", {}), (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 501);
});

test("corrupt saved reviewer defaults remain visible without hiding valid repo preferences", async (t) => {
    const { store, settings, log } = await fixture(t);
    await settings.update("repo", { learning: "suggest" });
    await store.updateSettings((document) => { document.agentReview = { ...defaults, skipDialog: "false" }; });
    const http = new SettingsHttp(settings, (message) => log.push(message));
    const state = createSettingsApi(async () => null).readState(await http.read("repo"));
    assert.equal(required(state.settings).learning, "suggest");
    assert.equal(state.agentReviewSettings, null);
    assert.equal(state.agentReviewSettingsAvailable, true);
    assert.match(state.agentReviewSettingsError ?? "", /boolean skipDialog/);
    assert.match(required(log.at(-1)), /could not read agent review defaults/);
});

test("browser decoders reject malformed success payloads instead of accepting typed-looking JSON", async () => {
    const api = createSettingsApi(async () => ({ ...effective, dismissed: "false" }));
    await assert.rejects(() => api.update({ learning: "suggest" }), /Invalid repository settings response/);
    const badDefaults = createSettingsApi(async () => ({ ...defaults, models: [null] }));
    await assert.rejects(() => badDefaults.updateAgentReview(defaults), (error) => hasCode(error, "invalid_input"));
    for (const value of [null, [], { settings: { ...effective, delivery: "later" } }, { agentReviewSettingsAvailable: "true" }]) {
        assert.throws(() => api.readState(value), /Invalid/);
    }
    assert.equal(api.readState({}).settings, null, "older hosts can omit optional settings");
});

test("checked SDK settings actions preserve validation, schema and change notification", async (t) => {
    const { settings } = await fixture(t);
    let changes = 0;
    const actions = settingsActions({ settings, changed: () => { changes++; }, guard: (handler) => handler });
    const [get, set] = actions;
    assert.equal(get.name, "get_agent_review_settings");
    assert.equal(set.name, "set_agent_review_settings");
    const schema = set.inputSchema as CanvasJsonSchema;
    assert.equal((schema as unknown as Record<string, unknown>).additionalProperties, false);
    const actionContext: Parameters<typeof get.handler>[0] = {
        sessionId: "test-session", extensionId: "test-extension", canvasId: "settings", instanceId: "test-instance",
        actionName: get.name,
    };
    assert.equal(await get.handler(actionContext), null);
    assert.deepEqual(await set.handler({ ...actionContext, actionName: set.name, input: { defaults } }), defaults);
    assert.equal(changes, 1);
    const invokeRawInput = set.handler as unknown as (context: Omit<Parameters<typeof set.handler>[0], "input"> & { input: unknown }) => Promise<unknown>;
    const invalidInputs: unknown[] = [null, [], {}, { defaults: { ...defaults, skipDialog: "true" } }];
    for (const input of invalidInputs) {
        await assert.rejects(() => invokeRawInput({ ...actionContext, actionName: set.name, input }), (error: unknown) => hasCode(error, "invalid_input"));
    }
    assert.equal(changes, 1, "failed writes must not announce a settings change");
    assert.deepEqual(await get.handler(actionContext), defaults);
    assert.equal(await set.handler({ ...actionContext, actionName: set.name, input: { defaults: null } }), null);
    assert.equal(changes, 2);
});
