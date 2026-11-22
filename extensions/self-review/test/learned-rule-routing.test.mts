import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Delivery, ReviewService, SettingsService, Store, runGit, startReviewServer } from "./modules.mjs";

// End-to-end coverage of docs/learned-rule-destinations.md: real git repository, settings store, review
// service and HTTP server, driven through the same endpoints the canvas uses.

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");
const git = (cwd: string, ...args: string[]) => runGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args]);

const ANALYZERS = "src/ErrorProne.NET.CoreAnalyzers";
const SOURCES = {
    check: `${ANALYZERS}/Rules/Check.cs`,
    facts: `${ANALYZERS}/Facts.cs`,
    sibling: "src/ErrorProne.NET.CoreAnalyzers.Tests/CheckTests.cs",
    helper: "src/ErrorProne.NET.Core/Helper.cs",
    script: "web/app.ts",
    guide: "docs/guide.md",
};
const DOCUMENTATION = ".github/instructions/csharp-documentation.instructions.md";
const DOCUMENTATION_TEXT = `---\napplyTo: "**/*.cs"\n---\n\n# Documentation\n`;
const CSHARP = ".github/instructions/csharp.instructions.md";
const GENERAL = ".github/copilot-instructions.md";
const CSHARP_DESTINATION = { kind: "language", language: "csharp", applyTo: "**/*.cs" };
const mapping = (pathPrefix: string, instructionRoot: string, splitLanguageSpecific: boolean) => ({ pathPrefix, instructionRoot, splitLanguageSpecific });
const sorted = (...files: string[]) => [...files].sort();

interface Json {
    status?: string;
    savedTo?: string | null;
    saveError?: string;
    needsConfirmation?: boolean;
    instructionMappings?: unknown[];
    settings?: { instructionMappings: unknown[] };
    error?: { code: string; message: string };
}

function required<T>(value: T | null | undefined): T {
    assert.ok(value);
    return value;
}

async function createFixture(t: TestContext) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "sr-rule-routing-"));
    t.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const repo = path.join(tmp, "ErrorProne.NET");
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    const write = async (relative: string, contents: string) => {
        const file = path.join(repo, ...relative.split("/"));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, contents);
    };
    for (const source of Object.values(SOURCES)) await write(source, "// base\n");
    await write(DOCUMENTATION, DOCUMENTATION_TEXT);
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "base");
    await git(repo, "checkout", "-q", "-b", "feature");
    for (const source of Object.values(SOURCES)) await write(source, "// base\n// changed\n");

    const store = new Store(path.join(tmp, "data"));
    const settings = new SettingsService({ store });
    const service = new ReviewService({
        store, settings, autoSaveLearnedRules: async (repoRoot) => (await settings.get(repoRoot)).autoSaveLearnedRules,
    });
    const reviewId = await service.ensureReview({ repoPath: repo, base: "main" });
    const delivery = new Delivery({ service, send: async () => "sm-1", reviewIds: () => [reviewId] });

    const read = (relative: string) => readFile(path.join(repo, ...relative.split("/")), "utf8");
    const instructionFiles = async () => (await readdir(repo, { recursive: true }))
        .map((entry) => entry.replace(/\\/g, "/"))
        .filter((entry) => /(^|\/)\.github\/.+\.md$/.test(entry))
        .sort();
    const lesson = async (lessonId: string) => required((await service.getReview(reviewId)).lessons.find((item) => item.lessonId === lessonId));
    const propose = async (reviewedFile: string, rule: string, extra: { destination?: { kind: "general" } } = {}) => {
        const { thread, message } = await service.createThread(reviewId, { kind: "file", path: reviewedFile, body: `/learn ${rule}`, author: "user" });
        const reply = await service.addMessage(reviewId, thread.threadId, {
            author: "agent", inReplyTo: message.messageId, body: rule, lessons: [{ rule, scope: "repo", ...extra }],
        });
        return required(reply.message.lessonIds?.[0]);
    };

    async function withApi<T>(fn: (api: {
        get: (pathName: string) => Promise<{ status: number; json: Json }>;
        post: (pathName: string, body: unknown) => Promise<{ status: number; json: Json }>;
        preview: (lessonId: string, body?: unknown) => Promise<{ status: number; json: Json }>;
        save: (lessonId: string, body: Record<string, unknown>) => Promise<{ status: number; json: Json }>;
        settingsMappings: () => Promise<unknown[]>;
    }) => Promise<T>): Promise<T> {
        const server = await startReviewServer({ instanceId: "rule-routing", getReviewId: () => reviewId, service, delivery, settings, webRoot: WEB_ROOT });
        try {
            const url = new URL(server.url);
            const token = required(url.searchParams.get("t"));
            const headers = { "X-MR-Token": token, "X-MR-Review": reviewId, "Content-Type": "application/json" };
            const call = async (method: string, pathName: string, body?: unknown) => {
                const response = await fetch(new URL(`/api/${pathName}`, url), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
                return { status: response.status, json: await response.json() as Json };
            };
            const post = (pathName: string, body: unknown) => call("POST", pathName, body);
            return await fn({
                get: (pathName) => call("GET", pathName),
                post,
                preview: (lessonId, body = {}) => post(`lessons/${lessonId}/destination`, body),
                save: (lessonId, body) => post(`lessons/${lessonId}/save`, { scope: "repo", ...body }),
                settingsMappings: async () => required((await call("GET", "state")).json.settings).instructionMappings,
            });
        } finally {
            await server.close();
        }
    }

    return { repo, store, settings, service, reviewId, read, write, instructionFiles, lesson, propose, withApi };
}

test("first use confirms the mapping, creates the exact language file beside existing documentation rules, and survives a provider restart", async (t) => {
    const f = await createFixture(t);
    const analyzers = mapping(ANALYZERS, "", true);
    await f.withApi(async (api) => {
        assert.deepEqual(await api.settingsMappings(), []);
        const first = "Document every public analyzer.";
        const firstId = await f.propose(SOURCES.check, first);
        const proposed = await f.lesson(firstId);
        assert.deepEqual([proposed.reviewedPath, proposed.destination], [SOURCES.check, CSHARP_DESTINATION]);

        const unmapped = await api.save(firstId, { rule: first });
        assert.deepEqual([unmapped.status, unmapped.json.status], [200, "proposed"]);
        assert.match(unmapped.json.saveError ?? "", /Choose an instruction destination/);
        assert.deepEqual(await f.instructionFiles(), [DOCUMENTATION], "no instruction file is written without a mapping");

        const preview = await api.preview(firstId, { mapping: analyzers, destination: CSHARP_DESTINATION });
        assert.deepEqual(preview.json, { savedTo: CSHARP, needsConfirmation: true });
        assert.deepEqual(await api.settingsMappings(), [], "a preview does not persist the mapping");
        assert.deepEqual(await f.instructionFiles(), [DOCUMENTATION]);

        const saved = await api.save(firstId, { rule: first, mapping: analyzers, destination: CSHARP_DESTINATION, expectedSavedTo: CSHARP });
        assert.deepEqual([saved.status, saved.json.status, saved.json.savedTo], [200, "saved", CSHARP]);
        assert.equal(await f.read(CSHARP), `---\napplyTo: "**/*.cs"\n---\n\n- ${first}\n`);
        assert.equal(await f.read(DOCUMENTATION), DOCUMENTATION_TEXT, "the topical documentation file is never reused");
        assert.deepEqual(await api.settingsMappings(), [analyzers]);

        const second = "Name analyzer diagnostics consistently.";
        const secondId = await f.propose(SOURCES.facts, second);
        assert.deepEqual((await api.preview(secondId)).json, { savedTo: CSHARP, needsConfirmation: false });
        assert.equal((await api.save(secondId, { rule: second, expectedSavedTo: CSHARP })).json.status, "saved");
        assert.equal((await api.save(secondId, { rule: second })).json.status, "saved", "saving again is idempotent");
        assert.equal(await f.read(CSHARP), `---\napplyTo: "**/*.cs"\n---\n\n- ${first}\n\n- ${second}\n`);
        assert.deepEqual(await f.instructionFiles(), sorted(CSHARP, DOCUMENTATION));
    });

    const reopenedStore = new Store(f.store.root);
    const reopened = new ReviewService({ store: reopenedStore, settings: new SettingsService({ store: reopenedStore }) });
    assert.deepEqual((await reopened.getReview(f.reviewId)).lessons.map((item) => [item.status, item.savedTo]), [["saved", CSHARP], ["saved", CSHARP]]);
    assert.deepEqual((await new SettingsService({ store: reopenedStore }).get(f.repo)).instructionMappings, [analyzers]);
});

test("the longest whole path prefix selects the instruction root and unmapped files are never written anywhere", async (t) => {
    const f = await createFixture(t);
    const mappings = [mapping(ANALYZERS, "", true), mapping(`${ANALYZERS}/Rules`, ANALYZERS, true)];
    await f.withApi(async (api) => {
        assert.deepEqual((await api.post("settings", { instructionMappings: mappings })).json.instructionMappings, mappings);

        for (const [reviewedFile, savedTo] of [
            [SOURCES.check, `${ANALYZERS}/${CSHARP}`],
            [SOURCES.facts, CSHARP],
        ]) {
            const rule = `Keep ${path.posix.basename(reviewedFile)} analyzers focused.`;
            const lessonId = await f.propose(reviewedFile, rule);
            assert.deepEqual((await api.preview(lessonId)).json, { savedTo, needsConfirmation: true });
            const saved = await api.save(lessonId, { rule, expectedSavedTo: savedTo });
            assert.deepEqual([saved.json.status, saved.json.savedTo], ["saved", savedTo]);
        }

        // "CoreAnalyzers.Tests" shares a string prefix with "CoreAnalyzers" but is not inside it.
        for (const reviewedFile of [SOURCES.sibling, SOURCES.helper]) {
            const rule = `Keep ${path.posix.basename(reviewedFile)} deterministic.`;
            const lessonId = await f.propose(reviewedFile, rule);
            const preview = await api.preview(lessonId);
            assert.equal(preview.status, 400);
            assert.match(preview.json.error?.message ?? "", /Choose an instruction destination/);
            const save = await api.save(lessonId, { rule });
            assert.deepEqual([save.status, save.json.status], [200, "proposed"]);
            assert.match(save.json.saveError ?? "", /Choose an instruction destination/);
        }
    });
    assert.deepEqual(await f.instructionFiles(), sorted(`${ANALYZERS}/${CSHARP}`, CSHARP, DOCUMENTATION));
    assert.equal(await f.read(DOCUMENTATION), DOCUMENTATION_TEXT);
});

test("the split setting chooses between the exact language file and an applicable scoped file, and repository-wide rules always use the general file", async (t) => {
    const f = await createFixture(t);
    const core = "src/ErrorProne.NET.Core";
    await f.withApi(async (api) => {
        await api.post("settings", { instructionMappings: [mapping(core, "", false)] });

        const unsplit = "Prefer expression-bodied members.";
        const unsplitId = await f.propose(SOURCES.helper, unsplit);
        assert.deepEqual((await api.preview(unsplitId)).json, { savedTo: DOCUMENTATION, needsConfirmation: false });
        assert.equal((await api.save(unsplitId, { rule: unsplit, expectedSavedTo: DOCUMENTATION })).json.savedTo, DOCUMENTATION);
        assert.equal(await f.read(DOCUMENTATION), `${DOCUMENTATION_TEXT}\n- ${unsplit}\n`);

        const wide = "Keep public APIs small.";
        const wideId = await f.propose(SOURCES.helper, wide, { destination: { kind: "general" } });
        assert.deepEqual((await api.preview(wideId)).json, { savedTo: GENERAL, needsConfirmation: false });
        assert.equal((await api.save(wideId, { rule: wide })).json.savedTo, GENERAL);
        assert.deepEqual(await f.instructionFiles(), sorted(DOCUMENTATION, GENERAL));

        await api.post("settings", { instructionMappings: [mapping(core, "", true)] });
        const split = "Avoid static mutable state.";
        const splitId = await f.propose(SOURCES.helper, split);
        assert.deepEqual((await api.preview(splitId)).json, { savedTo: CSHARP, needsConfirmation: true });
        assert.equal((await api.save(splitId, { rule: split, expectedSavedTo: CSHARP })).json.savedTo, CSHARP);
        assert.equal(await f.read(CSHARP), `---\napplyTo: "**/*.cs"\n---\n\n- ${split}\n`);
        assert.equal(await f.read(DOCUMENTATION), `${DOCUMENTATION_TEXT}\n- ${unsplit}\n`, "the scoped documentation file is untouched once splitting is on");

        const wideAgain = "Prefer small public surfaces.";
        const wideAgainId = await f.propose(SOURCES.helper, wideAgain, { destination: { kind: "general" } });
        assert.equal((await api.save(wideAgainId, { rule: wideAgain })).json.savedTo, GENERAL);
        assert.equal(await f.read(GENERAL), `- ${wide}\n\n- ${wideAgain}\n`);
    });
});

test("auto-save writes applicable rules and holds a rule that would create a scoped file until it is confirmed", async (t) => {
    const f = await createFixture(t);
    await f.write(CSHARP, `---\napplyTo: "**/*.cs"\n---\n\n# C#\n`);
    await f.withApi(async (api) => {
        await api.post("settings", { autoSaveLearnedRules: true, instructionMappings: [mapping("", "", true)] });

        const applicable = "Check cancellation tokens.";
        const applicableId = await f.propose(SOURCES.check, applicable);
        const autoSaved = await f.lesson(applicableId);
        assert.deepEqual([autoSaved.status, autoSaved.savedTo], ["saved", CSHARP]);
        assert.equal(await f.read(CSHARP), `---\napplyTo: "**/*.cs"\n---\n\n# C#\n\n- ${applicable}\n`);

        const wide = "Explain every public setting in the guide.";
        const wideId = await f.propose(SOURCES.guide, wide);
        assert.deepEqual([(await f.lesson(wideId)).status, (await f.lesson(wideId)).savedTo], ["saved", GENERAL]);
        assert.equal(await f.read(GENERAL), `- ${wide}\n`);

        const held = "Prefer const assertions.";
        const heldId = await f.propose(SOURCES.script, held);
        const proposal = await f.lesson(heldId);
        const scoped = ".github/instructions/typescript.instructions.md";
        assert.deepEqual([proposal.status, proposal.savedTo], ["proposed", null]);
        assert.match(proposal.saveError ?? "", /Confirm creating \.github\/instructions\/typescript\.instructions\.md/);
        assert.deepEqual(await f.instructionFiles(), sorted(CSHARP, DOCUMENTATION, GENERAL));

        assert.deepEqual((await api.preview(heldId)).json, { savedTo: scoped, needsConfirmation: true });
        const confirmed = await api.save(heldId, { rule: held, expectedSavedTo: scoped });
        assert.deepEqual([confirmed.json.status, confirmed.json.savedTo], ["saved", scoped]);
        assert.equal(await f.read(scoped), `---\napplyTo: "**/*.ts"\n---\n\n- ${held}\n`);
    });
});
