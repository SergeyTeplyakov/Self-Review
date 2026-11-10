import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentReviewDefaults, reviewOptions, settingsDocument, settingsPatch } from "../dist/web/contracts.mjs";
import { createSettingsApi } from "../dist/web/settings-api.mjs";
import { Store } from "../dist/lib/store.mjs";
import { SettingsService, resolveDelivery } from "../dist/lib/settings.mjs";
import { SettingsHttp } from "../dist/lib/settings-http.mjs";
import { settingsActions } from "../dist/lib/settings-actions.mjs";

const defaults = { models: ["model-a", "copilot-fusion"], focus: "both", intent: "Check contracts.", skipDialog: false };
const effective = { repoName: "repo", learning: "suggest", delivery: "ask", configured: true, dismissed: false };

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "sr-contracts-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root);
    const log = [];
    const settings = new SettingsService({
        store, log: (message) => log.push(message),
        git: { runGit: async () => ({ ok: true, stdout: "https://github.com/owner/repo.git", stderr: "" }) },
    });
    return { store, settings, log };
}

test("shared options and patch codecs reject untrusted input without type assertions", () => {
    assert.deepEqual(reviewOptions(defaults), { models: defaults.models, focus: "both", intent: defaults.intent });
    assert.deepEqual(agentReviewDefaults(defaults), defaults);
    assert.deepEqual(settingsPatch({ learning: "off", dismissed: false }), { learning: "off", delivery: undefined, dismissed: false });
    for (const value of [null, [], {}, { models: ["model-a"], focus: "invalid" }, { ...defaults, models: ["a", "a"] }, { ...defaults, intent: 3 }]) {
        assert.throws(() => reviewOptions(value), (err) => err.code === "invalid_input");
    }
    for (const value of [undefined, null, [], {}, { learning: "batch" }, { delivery: "auto" }, { dismissed: "false" }]) {
        assert.throws(() => settingsPatch(value), (err) => err.code === "invalid_input");
    }
    assert.throws(() => agentReviewDefaults({ ...defaults, skipDialog: "false" }), (err) => err.code === "invalid_input");
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
    assert.match(log.at(-1), /settings unreadable/);
    const special = settingsDocument(JSON.parse('{"repos":{"__proto__":{"learning":"off"}}}'));
    assert.equal(Object.hasOwn(special.repos, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(special.repos), Object.prototype);
});

test("checked HTTP and browser settings boundaries round-trip persisted choices", async (t) => {
    const { store, settings, log } = await fixture(t);
    const http = new SettingsHttp(settings, (message) => log.push(message));
    const posts = [];
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
    assert.deepEqual(await new SettingsService({ store, git: settings.git }).getAgentReview(), defaults);
    assert.equal(await api.updateAgentReview(null), null);
    assert.equal((await http.read("repo")).agentReviewSettings, null);
    await assert.rejects(() => http.updateAgentReview(null), (err) => err.code === "invalid_input");
    await assert.rejects(() => http.update("repo", []), (err) => err.code === "invalid_input");
    assert.deepEqual(await new SettingsHttp(undefined, () => {}).read("repo"), {
        settings: null, agentReviewSettings: null, agentReviewSettingsAvailable: false,
    });
    await assert.rejects(() => new SettingsHttp(undefined, () => {}).update("repo", {}), (err) => err.status === 501);
});

test("corrupt saved reviewer defaults remain visible without hiding valid repo preferences", async (t) => {
    const { store, settings, log } = await fixture(t);
    await settings.update("repo", { learning: "suggest" });
    await store.updateSettings((document) => { document.agentReview = { ...defaults, skipDialog: "false" }; });
    const http = new SettingsHttp(settings, (message) => log.push(message));
    const state = createSettingsApi(async () => null).readState(await http.read("repo"));
    assert.equal(state.settings.learning, "suggest");
    assert.equal(state.agentReviewSettings, null);
    assert.equal(state.agentReviewSettingsAvailable, true);
    assert.match(state.agentReviewSettingsError, /boolean skipDialog/);
    assert.match(log.at(-1), /could not read agent review defaults/);
});

test("browser decoders reject malformed success payloads instead of accepting typed-looking JSON", async () => {
    const api = createSettingsApi(async () => ({ ...effective, dismissed: "false" }));
    await assert.rejects(() => api.update({ learning: "suggest" }), /Invalid repository settings response/);
    const badDefaults = createSettingsApi(async () => ({ ...defaults, models: [null] }));
    await assert.rejects(() => badDefaults.updateAgentReview(defaults), (err) => err.code === "invalid_input");
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
    assert.equal(set.inputSchema.additionalProperties, false);
    assert.equal(await get.handler({}), null);
    assert.deepEqual(await set.handler({ input: { defaults } }), defaults);
    assert.equal(changes, 1);
    for (const input of [null, [], {}, { defaults: { ...defaults, skipDialog: "true" } }]) {
        await assert.rejects(() => set.handler({ input }), (err) => err.code === "invalid_input");
    }
    assert.equal(changes, 1, "failed writes must not announce a settings change");
    assert.deepEqual(await get.handler({}), defaults);
    assert.equal(await set.handler({ input: { defaults: null } }), null);
    assert.equal(changes, 2);
});
