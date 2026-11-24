import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseUnifiedDiff } from "./modules.mjs";
import { loadApp as runApp, MockElement } from "./load-app.mjs";

// Loads the page script into a bare vm context. Elements are created on demand and remembered per selector,
// so a test can render one piece of the page and read its markup back.
interface MockNode {
    innerHTML: string;
    textContent: string;
    className: string;
    hidden: boolean;
    inert?: boolean;
    scrollTop: number;
    insertAdjacentHTML?: (position: InsertPosition, html: string) => void;
    focus: () => number | void;
    setSelectionRange?: (start: number, end: number) => void;
    selectionRange?: [number, number];
    tagName?: string;
    dataset?: Record<string, string>;
    closest?: (selector: string) => MockNode | null;
    querySelector?: (selector: string) => unknown;
    querySelectorAll?: (selector: string) => MockNode[];
    contains?: (node: MockNode | null) => boolean;
    classList?: { toggle: (name: string, force?: boolean) => boolean };
}

interface DialogState {
    type?: string;
    models?: string;
    skillNames?: string[];
    saveSkillDefaults?: boolean;
    saveDefaults?: boolean;
    skipDialog?: boolean;
    intent?: string;
    focus?: string;
    saving?: boolean;
    error?: string;
    autoSaveLearnedRules?: boolean;
    delivery?: string;
    commentConcurrency?: number;
    instructionMappings?: Array<{ pathPrefix: string; instructionRoot: string; splitLanguageSpecific: boolean }>;
    revisionId?: string;
    model?: string;
}

interface RuntimeState {
    [key: string]: unknown;
    review: Record<string, unknown> & { reviewId: string; scope?: string; threads: Array<{ status: string; messages: unknown[] }> };
    dialog: DialogState | null;
    settings: Record<string, unknown> & { autoSaveLearnedRules?: boolean; delivery: string; configured: boolean; repoName?: string } | null | undefined;
    skillOverrides: Map<string, Set<string>>;
    open: Set<string>;
    expanded: Set<string>;
    collapsedThreads: Set<string>;
    focusedComposer: string | null;
    approving: Set<string>;
    agentReviewAvailable: boolean;
    agentReviewSettingsAvailable: boolean;
    reviewSkillsAvailable: boolean;
    agentReviewSettings: { models: string[]; focus: string; intent?: string; skipDialog: boolean } | null;
    agentReviewSettingsError?: string;
    agentReviewSuggestedModels?: string[];
    busy?: boolean | null;
    startingReview?: boolean;
    switching?: boolean;
    submitting?: boolean;
    snapshot?: { revisionId?: string; files?: unknown[] };
    view?: { type?: string };
}

type MockFetch = (url: string, options?: { method?: string; body?: string }) => Promise<unknown>;
type CapturedPost = [string, ...unknown[]];
type MockFocusable = {
    focus?: MockNode["focus"];
    checked?: boolean;
    tagName?: string;
    dataset?: Record<string, string>;
    selectionStart?: number;
    selectionEnd?: number;
};

interface LoadedApp {
    document: {
        addEventListener: () => void;
        querySelector: (selector: string) => MockNode;
        querySelectorAll: (selector: string) => MockFocusable[];
        activeElement: MockFocusable | null;
    };
    sessionStorage: ReturnType<typeof mockStorage>;
    localStorage: ReturnType<typeof mockStorage>;
    focused: string[];
    node: (selector: string) => MockNode;
    state: RuntimeState;
    run: {
        (code: "onClick" | "onInput" | "onChange" | "onKeyDown" | "trapTab"): (event: unknown) => unknown;
        <T = string>(code: string): T;
    };
    read: <T = unknown,>(expression: string) => T;
}

function mockStorage() {
    const items = new Map<string, string>();
    return {
        items,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, String(value)),
        removeItem: (key: string) => items.delete(key),
    };
}

async function loadApp(globals: Record<string, unknown> & { fetch?: MockFetch } = {}): Promise<LoadedApp> {
    const nodes = new Map<string, MockNode>();
    const focused: string[] = [];
    const node = (selector: string): MockNode => {
        if (!nodes.has(selector)) {
            let element: MockNode;
            element = Object.assign(new MockElement(), {
                innerHTML: "", textContent: "", className: "", hidden: false, inert: false, scrollTop: 0,
                insertAdjacentHTML: (_position: InsertPosition, html: string) => { element.innerHTML = html + element.innerHTML; },
                focus: () => focused.push(selector),
                setSelectionRange: (start: number, end: number) => { element.selectionRange = [start, end]; },
            });
            nodes.set(selector, element);
        }
        const found = nodes.get(selector);
        if (!found) throw new Error(`Missing mock node: ${selector}`);
        return found;
    };
    const document = { addEventListener() {}, querySelector: node, querySelectorAll: (_selector: string) => [] as MockFocusable[], activeElement: null as MockFocusable | null };
    const sessionStorage = mockStorage();
    const localStorage = (globals.localStorage as ReturnType<typeof mockStorage> | undefined) ?? mockStorage();
    const context = vm.createContext({
        URLSearchParams, location: { search: "" }, document, localStorage, sessionStorage,
        window: { setTimeout: () => 0 }, setInterval() {}, setTimeout: () => 0, clearTimeout() {}, ...globals,
    });
    await runApp(context);
    return {
        document, sessionStorage, localStorage, focused, node,
        state: vm.runInContext("state", context) as RuntimeState,
            run: Object.assign((code: string) => vm.runInContext(code, context) as unknown, {}) as LoadedApp["run"],
        read: <T = unknown,>(expression: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) as T,
    };
}

const reviewFixture = (overrides: Record<string, unknown> = {}) => ({
    reviewId: "r", title: "Feature work", repoRoot: "C:\\repo", base: "main", branch: "feature", scope: "all", currentRevisionId: "r1",
    revisions: [{ revisionId: "r1", files: 2, additions: 3, deletions: 1, createdAt: "2026-01-01T00:00:00Z" }],
    git: { branch: "feature", headCommit: "abc", baseCommit: "def", upstream: { name: "origin/feature", ahead: 1, behind: 2 }, uncommittedFiles: 3 },
    threads: [], lessons: [],
    ...overrides,
});
const settingsFixture = (overrides: Record<string, unknown> = {}) => ({ repoName: "repo", autoSaveLearnedRules: false, delivery: "immediate", instructionMappings: [], configured: false, dismissed: false, ...overrides });

test("agent reply renders Markdown issue links as external anchors", async () => {
    const app = await loadApp();
    const body = "See [#31](https://github.com/SergeyTeplyakov/Self-Review/issues/31) and "
        + "[**docs & notes**](http://example.test/a(b)?x=1&y=2 \"References\").";
    const message = { messageId: "reply", author: "agent", body, createdAt: "2026-01-01T00:00:00Z" };
    const html = app.run(`messageHtml(${JSON.stringify(message)})`);
    assert.ok(html.includes('<a href="https://github.com/SergeyTeplyakov/Self-Review/issues/31" target="_blank" rel="noopener noreferrer" data-markdown-link>#31</a>'));
    assert.ok(html.includes('<a href="http://example.test/a(b)?x=1&amp;y=2" target="_blank" rel="noopener noreferrer" data-markdown-link><strong>docs &amp; notes</strong></a>'));
});

test("state and lessons from an older server need no learned-rule destination fields", async () => {
    const app = await loadApp();
    const legacyLesson = {
        lessonId: "lesson", messageId: "message", scope: "repo", rule: "Keep pull requests focused.",
        savedTo: null, threadId: "thread", createdAt: "2026-01-01T00:00:00Z",
    };
    const legacyReview = reviewFixture({ lessons: [legacyLesson] });
    assert.equal(app.run(`isLesson(${JSON.stringify(legacyLesson)})`), true);
    assert.equal(app.run(`isStateResponse(${JSON.stringify({ review: legacyReview })})`), true);
});

test("reply Markdown respects matching code delimiters and escaped URL punctuation", async () => {
    const app = await loadApp();
    const body = "``literal ` [not a link](https://example.test/)`` and [ref](https://example.test/a\\(b\\))";
    const html = app.run(`md(${JSON.stringify(body)})`);
    assert.ok(html.includes("<code>literal ` [not a link](https://example.test/)</code>"));
    assert.equal(html.match(/<a\b/g)?.length, 1);
    assert.match(html, /href="https:\/\/example\.test\/a\(b\)"/);
});

test("very long Markdown lines fall back to escaped text", async () => {
    const app = await loadApp();
    const line = "[details](https://example.test/) " + "x".repeat(5000) + " <literal>";
    assert.equal(app.run(`md(${JSON.stringify(line)})`), `<div class="md"><p>${line.replace("<literal>", "&lt;literal&gt;")}</p></div>`);
});

test("reply Markdown respects code inside bold and balanced link labels", async () => {
    const app = await loadApp();
    const body = "**Use `** [#31](https://example.test/)` literally**\n"
        + "[`T[]`](https://example.test/types) [array[i]](https://example.test/arrays) "
        + "[`x]` and \\[y\\]](https://example.test/brackets)";
    const html = app.run(`md(${JSON.stringify(body)})`);
    assert.ok(html.includes("<strong>Use <code>** [#31](https://example.test/)</code> literally</strong>"));
    assert.equal(html.match(/<a\b/g)?.length, 3);
    assert.ok(html.includes("data-markdown-link><code>T[]</code></a>"));
    assert.ok(html.includes("data-markdown-link>array[i]</a>"));
    assert.ok(html.includes("data-markdown-link><code>x]</code> and [y]</a>"));
});

test("reply Markdown accepts angle destinations and decodes references before validating URLs", async () => {
    const app = await loadApp();
    const references = new Map([["&amp;", "&"], ["&#x32;", "2"], ["&colon;", ":"]]);
    Object.assign(app.document, { createElement: (tag: string) => {
        assert.equal(tag, "textarea");
        return {
            value: "",
            set innerHTML(reference: string) {
                assert.ok(references.has(reference), "only a single known reference reaches the decoder");
                this.value = references.get(reference) ?? "";
            },
        };
    } });
    const body = "[issue](<https://example.test/a b>) [search](https://example.test/?q=one&amp;page=&#x32;) "
        + "[literal](https://example.test/?q=one\\&amp;page=2) [local](file&colon;///tmp/notes)";
    const html = app.run(`md(${JSON.stringify(body)})`);
    assert.equal(html.match(/<a\b/g)?.length, 3);
    assert.match(html, /href="https:\/\/example\.test\/a%20b"/);
    assert.match(html, /href="https:\/\/example\.test\/\?q=one&amp;page=2"/);
    assert.match(html, /href="https:\/\/example\.test\/\?q=one&amp;amp;page=2"/);
    assert.match(html, /\[local\]\(file&amp;colon;\/\/\/tmp\/notes\)/);
});

test("agent reply keeps non-web destinations, raw HTML and code inert", async () => {
    const app = await loadApp();
    const body = [
        "[local](//example.test/path) [file](file:///temp/notes) [bad](https://)",
        '<b>raw markup</b> [<i>label</i>](https://example.test/)',
        '![image](https://example.test/pixel.png) `[code](https://example.test/)`',
        "```md\n[fenced](https://example.test/)\n```",
    ].join("\n");
    const message = { messageId: "reply", author: "agent", body, createdAt: "2026-01-01T00:00:00Z" };
    const html = app.run(`messageHtml(${JSON.stringify(message)})`);
    assert.equal(html.match(/<a\b/g)?.length, 1, "only the valid link becomes an anchor");
    assert.doesNotMatch(html, /<(?:b|i|img)\b/);
    assert.ok(html.includes("[local](//example.test/path) [file](file:///temp/notes) [bad](https://)"));
    assert.ok(html.includes("&lt;b&gt;raw markup&lt;/b&gt;"));
    assert.ok(html.includes("&lt;i&gt;label&lt;/i&gt;</a>"));
    assert.ok(html.includes("<code>[code](https://example.test/)</code>"));
    assert.ok(html.includes("<pre><code>[fenced](https://example.test/)</code></pre>"));
});

test("tree root and root folder use the repository identity, retaining the checkout tooltip", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture({ repoRoot: "C:\\worktrees\\generated-workspace-id" });
    app.state.snapshot = { revisionId: "r1", files: [] };
    for (const name of ["Self-Review", "local-repo", "Repo <name>"]) {
        app.state.settings = settingsFixture({ repoName: name });
        const escaped = name.replace("<", "&lt;").replace(">", "&gt;");
        const tree = app.run<string>('(() => { const out = []; treeHtml(buildTree([]), 0, out); return out.join(""); })()');
        assert.ok(tree.includes(`<span class="name">${escaped}</span>`));
        assert.ok(tree.includes('title="C:\\worktrees\\generated-workspace-id'));
        assert.ok(app.run<string>('folderView("")').includes(`<span class="path">${escaped}</span>`));
    }
    app.state.settings = null;
    assert.equal(app.run('buildTree([]).name'), "generated-workspace-id", "older providers without settings retain the checkout fallback");
});

const jsonResponse = (data: unknown, status = 200) => ({ ok: status < 400, status, statusText: status < 400 ? "OK" : "Error", json: async () => data });

test("Markdown links in replies and verification prevent canvas navigation and leave Open PR alone", async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    const app = await loadApp({ fetch: async (url, opts) => {
        requests.push({ url, method: opts?.method, body: opts?.body });
        return jsonResponse({ ok: true });
    } });
    const href = "https://example.test/a?x=1&y=2";
    const message = {
        messageId: "reply", author: "agent", body: "Result", createdAt: "2026-01-01T00:00:00Z",
        verification: `[Verification run](${href})`,
    };
    assert.match(app.run(`messageHtml(${JSON.stringify(message)})`),
        /<div class="verification">Verification: <a [^>]+ data-markdown-link>Verification run<\/a>/);
    const link = Object.assign(new MockElement("A"), { href });
    const target = new MockElement("STRONG");
    target.closest = (selector) => selector === "a[data-markdown-link][href]" ? link : null;
    let prevented = 0;
    const preventDefault = () => { prevented++; };
    await app.run("onClick")({ target, preventDefault });
    const openPR = new MockElement("A");
    openPR.closest = () => null;
    await app.run("onClick")({ target: openPR, preventDefault });
    assert.equal(prevented, 1);
    assert.deepEqual(requests, [{ url: "/api/open-comment-link", method: "POST", body: JSON.stringify({ url: href }) }]);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test("loading waits for a matching snapshot and never publishes an SSE-invalidated Overview", async () => {
    const snapshotStarted = deferred<void>();
    const snapshot = deferred<ReturnType<typeof jsonResponse>>();
    let reads = 0;
    const app = await loadApp({ fetch: async (url) => {
        if (url === "/api/state") {
            reads++;
            return jsonResponse({ review: reviewFixture({
                currentRevisionId: reads === 1 ? "r1" : "r2",
                description: { version: reads, revisionId: reads === 1 ? "r1" : "r2", body: reads === 1 ? "Older overview" : "Current overview" },
            }) });
        }
        if (url === "/api/snapshot/r1") {
            snapshotStarted.resolve();
            return snapshot.promise;
        }
        if (url === "/api/snapshot/r2") return jsonResponse({ revisionId: "r2", files: [] });
        throw new Error(`Unexpected request ${url}`);
    } });
    app.run("var renderedDescriptions = []; render = () => { renderedDescriptions.push(state.review.description.body); };");
    const loading = app.run<Promise<void>>("loadState()");
    assert.match(app.node("#review-status").innerHTML, /Loading review and Overview/);
    await snapshotStarted.promise;
    assert.equal(app.read("state.review"), null, "neither the tree nor Overview is published without the snapshot");
    app.run("scheduleReload()");
    snapshot.resolve(jsonResponse({ revisionId: "r1", files: [] }));
    await loading;
    assert.deepEqual(app.read("renderedDescriptions"), ["Current overview"]);
    assert.equal(app.state.review.currentRevisionId, "r2");
    assert.equal(app.state.snapshot?.revisionId, "r2");
    assert.equal(app.node("#review-status").hidden, true);
});

test("a reload queued during failed state or snapshot requests is retried automatically", async () => {
    for (const failedRequest of ["state", "snapshot/r1"]) {
        const failure = deferred<ReturnType<typeof jsonResponse>>();
        const requestStarted = deferred<void>();
        let stateRequests = 0;
        let snapshotRequests = 0;
        const timers: Array<() => void> = [];
        const app = await loadApp({
            window: { setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; } },
            fetch: async (url) => {
                if (url === "/api/state") {
                    stateRequests++;
                    if (failedRequest === "state" && stateRequests === 1) {
                        requestStarted.resolve();
                        return failure.promise;
                    }
                    const revision = failedRequest === "snapshot/r1" && stateRequests === 1 ? "r1" : "r2";
                    return jsonResponse({ review: reviewFixture({
                        currentRevisionId: revision,
                        description: { version: revision === "r1" ? 1 : 2, revisionId: revision, body: revision === "r1" ? "Old overview" : "Recovered overview" },
                    }) });
                }
                if (url === "/api/snapshot/r1") {
                    snapshotRequests++;
                    if (failedRequest === "snapshot/r1") {
                        requestStarted.resolve();
                        return failure.promise;
                    }
                    return jsonResponse({ revisionId: "r1", files: [] });
                }
                if (url === "/api/snapshot/r2") {
                    snapshotRequests++;
                    return jsonResponse({ revisionId: "r2", files: [] });
                }
                throw new Error(`Unexpected request ${url}`);
            },
        });
        app.run("renderRuler = () => {}");
        const initialLoad = app.run<Promise<void>>("loadState()");
        await requestStarted.promise;
        app.run("scheduleReload()");
        failure.resolve(jsonResponse({ error: { message: `temporary ${failedRequest} failure` } }, 503));
        await assert.rejects(initialLoad, new RegExp(`temporary ${failedRequest} failure`));

        assert.equal(timers.length, 1, "the failed load schedules the change-triggered retry");
        timers[0]?.();
        await app.run<Promise<void>>("loading");
        assert.equal(stateRequests, 2);
        assert.equal(app.state.review.currentRevisionId, "r2");
        assert.equal(app.read("state.review.description.body"), "Recovered overview");
        assert.equal(app.node("#review-status").hidden, true);
        if (failedRequest === "snapshot/r1") assert.equal(snapshotRequests, 2);
    }
});

test("refresh progress and load failure preserve the current view and composer DOM until a successful retry", async () => {
    let failed = false;
    let failureMessage = "offline <now>";
    let refresh: { status: string; error?: string } = { status: "refreshing" };
    const app = await loadApp({ fetch: async (url) => {
        if (failed) throw new Error(failureMessage);
        if (url === "/api/state") return jsonResponse({ review: reviewFixture(), refresh });
        throw new Error(`Unexpected request ${url}`);
    } });
    app.state.review = reviewFixture();
    app.state.snapshot = { revisionId: "r1", files: [] };
    app.state.view = { type: "overview" };
    const composer = Object.assign(Object.create(MockElement.prototype) as MockElement, {
        tagName: "TEXTAREA", value: "Keep this draft", dataset: { composer: "overview:new" }, selectionStart: 2, selectionEnd: 6,
    });
    app.document.activeElement = composer;
    app.localStorage.setItem("sr:r:draft:overview:new", "Keep this draft");
    const focusTarget = app.node('textarea[data-composer="overview:new"]');
    app.run("renderRuler = () => {}; globalThis.CSS = { escape: (value) => value };");
    await app.run("loadState()");
    assert.match(app.node("#review-status").innerHTML, /Refreshing review and Overview.*last loaded/);
    assert.match(app.node("#main").innerHTML, /<textarea data-composer="overview:new"[^>]*>Keep this draft<\/textarea>/);
    assert.ok(app.focused.includes('textarea[data-composer="overview:new"]'));
    assert.deepEqual(focusTarget.selectionRange, [2, 6]);
    failed = true;
    await assert.rejects(app.run<Promise<void>>("loadState()"), /offline/);
    assert.match(app.node("#review-status").innerHTML, /Could not load the current review.*offline &lt;now&gt;.*Retry/);
    failureMessage = "Invalid repository settings response.";
    await assert.rejects(app.run<Promise<void>>("loadState()"), /Invalid repository settings response/);
    const status = app.node("#review-status").innerHTML;
    assert.match(status, /Invalid repository settings response\. Showing the last loaded data/);
    assert.doesNotMatch(status, /response\.\./);
    assert.equal(app.node("#review-status").hidden, false);
    assert.equal(app.document.activeElement, composer);
    assert.equal(app.localStorage.getItem("sr:r:draft:overview:new"), "Keep this draft");
    assert.equal(app.state.view.type, "overview");
    failed = false;
    refresh = { status: "error", error: "Git capture failed" };
    await app.run("loadState()");
    assert.match(app.node("#review-status").innerHTML, /Git capture failed.*Retry/);
    refresh = { status: "idle" };
    await app.run("loadState()");
    assert.equal(app.node("#review-status").hidden, true);
});

test("manual refresh shows progress before the server responds and reports capture failure", async () => {
    const response = deferred<ReturnType<typeof jsonResponse>>();
    const app = await loadApp({ fetch: async () => response.promise });
    app.state.review = reviewFixture();
    const refreshing = app.run<Promise<void>>("refreshReview()");
    assert.match(app.node("#review-status").innerHTML, /Refreshing review and Overview/);
    response.resolve(jsonResponse({ error: { message: "capture failed" } }, 500));
    await assert.rejects(refreshing, /capture failed/);
    assert.match(app.node("#review-status").innerHTML, /Could not refresh from the working tree.*capture failed.*Retry/);
});

test("refresh progress SSE updates the status without requesting a duplicate full state reload", async () => {
    let requests = 0;
    const app = await loadApp({ fetch: async () => { requests++; return jsonResponse({}); } });
    app.state.review = reviewFixture();
    app.run('onRefreshProgress({ data: JSON.stringify({ status: "refreshing" }) })');
    assert.match(app.node("#review-status").innerHTML, /Refreshing review and Overview/);
    app.run('onRefreshProgress({ data: JSON.stringify({ status: "error", error: "capture failed" }) })');
    assert.match(app.node("#review-status").innerHTML, /Could not refresh from the working tree.*capture failed.*Retry/);
    assert.equal(requests, 0);
});

test("bottom status bar shows the build date with its build ID available on hover and focus", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.state.extensionVersion = { version: "0.3.0", buildId: "a1b2c3d4e5f6" };
    app.state.settings = settingsFixture();
    app.run("refreshing = true; renderLoadStatus()");
    const status = app.node("#review-status");
    const loadingHtml = status.innerHTML;
    assert.match(loadingHtml, /Refreshing review and Overview/);
    assert.match(app.node("#review-status-controls").innerHTML, /v0\.3\.0 · build a1b2c3d4e5f6/, "without a build date the build ID stays visible");

    app.state.extensionVersion = { version: "0.3.0", buildId: "a1b2c3d4e5f6", builtAt: "2026-11-20T20:44:58.000Z" };
    app.state.settings = settingsFixture({ autoSaveLearnedRules: true, delivery: "batch" });
    app.run("renderLoadStatus()");
    assert.equal(status.innerHTML, loadingHtml, "updating footer controls preserves the in-progress status DOM");
    const footer = app.node("#review-status-controls").innerHTML;
    const label = new Date("2026-11-20T20:44:58.000Z").toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    assert.ok(footer.includes(`>v0.3.0 · ${label}</span>`), footer);
    assert.doesNotMatch(footer, />v0\.3\.0 · build/, "the build ID moves out of the visible label");
    assert.match(footer, /tabindex="0" title="Self-Review extension version 0\.3\.0, build a1b2c3d4e5f6, built 2026-11-20T20:44:58\.000Z" aria-label="[^"]*build a1b2c3d4e5f6/);
    assert.doesNotMatch(footer, /Delivery:|Auto-save learned rules:/);

    app.run('refreshing = false; refreshError = "capture failed"; renderLoadStatus()');
    assert.match(status.innerHTML, /capture failed.*Retry/);
});

test("the bottom bar shows the version reported by the serving extension after loading review state", async () => {
    const app = await loadApp({ fetch: async (url) => {
        if (url === "/api/state") return jsonResponse({
            review: reviewFixture({ repoRoot: "C:\\reviews\\unrelated-checkout" }),
            extensionVersion: { version: "0.3.0", buildId: "c0ffee123456" },
        });
        if (url === "/api/snapshot/r1") return jsonResponse({ revisionId: "r1", files: [] });
        throw new Error(`Unexpected request ${url}`);
    } });
    app.run("renderRuler = () => {}");
    await app.run("loadState()");
    assert.match(app.node("#review-status-controls").innerHTML, /v0\.3\.0 · build c0ffee123456/);
});

test("missing and older descriptions are not presented as pending generation or current content", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    assert.match(app.run("descriptionHtml()"), /No saved description\. Descriptions are not generated automatically/);
    app.state.review = reviewFixture({ description: { version: 1, revisionId: "r0", body: "Original purpose" } });
    assert.match(app.run("descriptionHtml()"), /Earlier diff: description has not been updated for the current revision/);
});

const clicker = (app: LoadedApp) => (action: string, dataset: Record<string, string> = {}) => {
    const target = Object.assign(new MockElement("BUTTON"), { dataset: { action, ...dataset } });
    target.closest = () => target;
    return app.run("onClick")({ target });
};

function required<T>(value: T | null | undefined): T {
    assert.ok(value);
    return value;
}

const dialog = (app: LoadedApp): DialogState => required(app.state.dialog);

function requestBody(options: { method?: string; body?: string } | undefined): Record<string, unknown> {
    const body: unknown = JSON.parse(options?.body ?? "{}");
    assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
    return body as Record<string, unknown>;
}

function capturedBody(posts: CapturedPost[], index = -1): Record<string, unknown> {
    const post = required(posts.at(index));
    const body = post.at(-1);
    assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
    return body as Record<string, unknown>;
}

test("active threads can be collapsed and expanded without changing their status or replies", async () => {
    const thread = {
        threadId: "t1", kind: "line", status: "active",
        location: { path: "src/a.cs", side: "new", startLine: 10, endLine: 10, state: "current" },
        messages: [
            { messageId: "m1", author: "user", body: "Please explain this line.", createdAt: "2026-01-01T00:00:00Z" },
            { messageId: "m2", author: "agent", body: "It handles the retry.", createdAt: "2026-01-01T00:01:00Z" },
        ],
    };
    const app = await loadApp();
    app.state.review = reviewFixture({ threads: [thread] });
    app.state.snapshot = { revisionId: "r1", files: [] };
    const html = () => app.run<string>('threadHtml(state.review.threads[0])');
    const click = clicker(app);

    assert.match(html(), /aria-expanded="true">Hide/);
    await click("toggle", { thread: "t1" });
    assert.match(html(), /class="thread collapsed"/);
    assert.match(html(), /aria-expanded="false">Show/);
    assert.equal(app.state.review.threads[0].status, "active");
    assert.equal(app.state.review.threads[0].messages.length, 2);

    await click("toggle", { thread: "t1" });
    assert.doesNotMatch(html(), /class="thread collapsed"/);
    assert.match(html(), /aria-expanded="true">Hide/);
    assert.equal(app.state.review.threads[0].status, "active");
    assert.equal(app.state.review.threads[0].messages.length, 2);
});

test("hiding default-collapsed threads does not override the active, current default", async () => {
    for (const [status, locationState] of [
        ["resolved", "current"], ["wontfix", "current"], ["closed", "current"], ["active", "outdated"],
    ]) {
        const thread = {
            threadId: "t1", kind: "line", status,
            location: { path: "src/a.cs", side: "new", startLine: 10, endLine: 10, state: locationState },
            messages: [{ messageId: "m1", author: "user", body: "A comment", createdAt: "2026-01-01T00:00:00Z" }],
        };
        const app = await loadApp();
        app.state.review = reviewFixture({ threads: [thread] });
        app.state.snapshot = { revisionId: "r1", files: [] };
        const html = () => app.run<string>('threadHtml(state.review.threads[0])');
        const click = clicker(app);

        assert.match(html(), /aria-expanded="false">Show/);
        await click("toggle", { thread: "t1" });
        assert.match(html(), /aria-expanded="true">Hide/);
        await click("toggle", { thread: "t1" });
        assert.match(html(), /aria-expanded="false">Show/);
        thread.status = "active";
        thread.location.state = "current";
        assert.match(html(), /aria-expanded="true">Hide/, `${status}/${locationState} becomes active and current`);
    }
});

test("an outdated thread keeps its unfinished reply visible and labels it if manually collapsed", async () => {
    const thread = {
        threadId: "t1", kind: "line", status: "active",
        location: { path: "src/a.cs", side: "new", startLine: 10, endLine: 10, state: "current" },
        messages: [{ messageId: "m1", author: "user", body: "A comment", createdAt: "2026-01-01T00:00:00Z" }],
    };
    const app = await loadApp();
    app.state.review = reviewFixture({ threads: [thread] });
    app.state.snapshot = { revisionId: "r1", files: [] };
    app.run('setDraft("reply:t1", "Unfinished reply")');
    thread.location.state = "outdated";
    const html = () => app.run<string>("threadHtml(state.review.threads[0])");

    assert.match(html(), /aria-expanded="true">Hide/);
    assert.match(html(), /Unfinished reply<\/textarea>/);
    await clicker(app)("toggle", { thread: "t1" });
    assert.match(html(), /Unposted reply/);
    assert.match(html(), /aria-expanded="false">Show/);
    await clicker(app)("toggle", { thread: "t1" });
    assert.match(html(), /aria-expanded="true">Hide/);
});

test("an unposted reply can be recovered when its thread is outside the current view", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture({ threads: [{
        threadId: "t1", kind: "line", status: "active",
        location: { path: "src/a.cs", side: "new", startLine: 10, endLine: 10, state: "outdated" },
        messages: [{ messageId: "m1", author: "user", body: "A comment", createdAt: "2026-01-01T00:00:00Z" }],
    }] });
    app.state.snapshot = { revisionId: "r2", files: [] };
    app.run('setDraft("reply:t1", "Unfinished reply"); renderMain = () => { $("#main").innerHTML = "Other files remain"; }; renderRuler = () => {}; render();');
    assert.match(app.node("#main").innerHTML, /data-action="jump" data-thread="t1"[^>]*>Resume reply/);
    app.document.querySelectorAll = (selector) => selector === "#main [data-thread-id]" ? [{ dataset: { threadId: "t1" } }] : [];
    app.run("render()");
    assert.doesNotMatch(app.node("#main").innerHTML, /Resume reply/);
});

test("composer rerenders preserve leading newlines in both new comments and replies", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    for (const [key, options] of [
        ["file:file.ts", '{ kind: "file", path: "file.ts" }'], ["reply:t1", "{}"],
    ]) {
        app.run(`setDraft(${JSON.stringify(key)}, "\\n\\nDraft & <text>")`);
        const html = app.run<string>(`composerHtml(${JSON.stringify(key)}, ${options})`);
        // The HTML parser removes exactly one leading LF in a textarea.
        assert.match(html, /<textarea[^>]*>\n\n\nDraft &amp; &lt;text&gt;<\/textarea>/);
    }
});

test("an empty reply box is one line until opened and stays vertically resizable in both states", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const html = app.run<string>('composerHtml("reply:t1", {})');
    assert.match(html, /^<div class="composer" [^>]*><textarea[^>]*\brows="1"/);
    const css = await readFile(new URL("../dist/web/styles.css", import.meta.url), "utf8");
    const rule = (selector: string) => required(css.match(new RegExp(`${selector.replace(/[.()]/g, "\\$&")}\\s*\\{([^}]*)\\}`)))[1];
    assert.match(rule(".composer:not(.open) textarea"), /height:\s*34px/);
    assert.match(rule(".composer.open textarea"), /min-height:\s*80px/);
    assert.match(rule(".composer textarea"), /resize:\s*vertical/);
    for (const state of [".composer:not(.open) textarea", ".composer.open textarea"]) {
        assert.doesNotMatch(rule(state), /resize|max-height/, `${state} must not disable or cap resizing`);
    }
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const skillsApp = async (
    catalog: unknown,
    { fail = () => false, defaults }: { fail?: () => boolean; defaults?: RuntimeState["agentReviewSettings"] } = {},
) => {
    const posts: Array<[string, unknown]> = [];
    const app = await loadApp({ fetch: async (url: string, options?: { method?: string; body?: string }) => {
        if (options?.method === "POST") {
            const body: unknown = JSON.parse(options.body ?? "{}");
            posts.push([url, body]);
            return jsonResponse(url.includes("review-skills") ? catalog : typeof body === "object" && body !== null && "defaults" in body ? body.defaults : {});
        }
        if (fail()) throw new Error("Host discovery failed");
        return jsonResponse(catalog);
    } });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettingsAvailable = true;
    app.state.reviewSkillsAvailable = true;
    if (defaults) app.state.agentReviewSettings = defaults;
    return { app, posts, click: clicker(app) };
};

const NAMES = ["code-review-and-quality", "code-simplification", "ponytail-review"];

test("status shows the parallel limit separately from queued, running and applying comments", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.state.settings = { ...settingsFixture(), commentConcurrency: 4 };
    app.state.review.threads = [{ status: "active", messages: [
        { delivery: { state: "queued" } }, { delivery: { state: "processing", parallel: true } },
        { delivery: { state: "processing", parallel: true } }, { delivery: { state: "draft" } },
    ] }];
    app.state.busy = true;
    const status = () => { app.run("renderTop()"); return app.node("#top").innerHTML; };
    assert.match(status(), /Parallelism: 4/);
    assert.match(status(), /Copilot working · 1 queued · 2 running/);
    app.state.review.threads[0].messages = [{ delivery: { state: "processing", parallelPhase: "applying" } }];
    assert.match(status(), /0 queued · 0 running · 1 applying/);
    app.state.review.threads[0].messages = [{ delivery: { state: "queued", parallel: true } }];
    const waiting = status();
    assert.match(waiting, /Copilot busy · 1 queued · 0 running/, "a busy conversation that has not started a comment is not working on it");
    assert.doesNotMatch(waiting, /Copilot working/);
    assert.match(waiting, /title="Copilot is finishing other work in this conversation\. Queued comments start when it picks them up\."/);
    app.state.review.threads = [];
    app.state.settings.commentConcurrency = 1;
    assert.doesNotMatch(status(), /Parallelism/);
    assert.match(status(), /Copilot busy<\/span>/);
});

test("the Parallelism badge opens the repository concurrency control and disappears after saving serial mode", async () => {
    const calls: CapturedPost[] = [];
    const app = await loadApp({ fetch: async (url, init) => {
        calls.push([init?.method ?? "GET", url, requestBody(init)]);
        return jsonResponse(settingsFixture({ commentConcurrency: 1 }));
    } });
    app.state.review = reviewFixture();
    app.state.settings = settingsFixture({ commentConcurrency: 3 });
    app.run("renderTop()");
    const badge = required(app.node("#top").innerHTML.match(/<button\b[^>]*data-action="([^"]+)"[^>]*>Parallelism: 3<\/button>/));
    const click = clicker(app);
    await click(badge[1]);
    assert.match(app.node("#dialog").innerHTML, /<option value="3" selected>3<\/option>/);
    assert.equal(app.focused.at(-1), '#dialog select[name="commentConcurrency"]');
    await click("dialog-cancel");
    assert.equal(app.focused.at(-1), `[data-action="${badge[1]}"]`);
    assert.deepEqual(calls, []);

    await click(badge[1]);
    await app.run("onChange")({ target: { name: "commentConcurrency", value: "1" } });
    await click("dialog-save");
    assert.deepEqual(calls, [["POST", "/api/settings", { autoSaveLearnedRules: false, delivery: "immediate", commentConcurrency: 1 }]]);
    assert.doesNotMatch(app.node("#top").innerHTML, /Parallelism/);
    assert.equal(app.focused.at(-1), '[data-action="configure"]');
});

test("batch delivery disables concurrency without overwriting the immediate-mode limit", async () => {
    const patches: Record<string, unknown>[] = [];
    const app = await loadApp({ fetch: async (_url, init) => {
        const patch = requestBody(init);
        patches.push(patch);
        return jsonResponse(settingsFixture({ commentConcurrency: 3, ...patch }));
    } });
    app.state.review = reviewFixture({ deliveryMode: "batch" });
    app.state.settings = settingsFixture({ commentConcurrency: 3 });
    const click = clicker(app);
    const change = (name: string, value: string) => app.run("onChange")({ target: { name, value } });
    await click("configure-parallelism");
    await change("commentConcurrency", "2");
    for (const delivery of ["ask", "batch"]) {
        await change("delivery", delivery);
        const html = app.node("#dialog").innerHTML;
        assert.match(html, /<select name="commentConcurrency"[^>]* disabled>/);
        assert.match(html, /Batched comments are sent together/);
        assert.match(html, /<option value="3" selected>/);
    }
    await click("dialog-save");
    assert.deepEqual(patches, [{ delivery: "batch", autoSaveLearnedRules: false }]);
    assert.doesNotMatch(app.node("#top").innerHTML, /Parallelism:/);
    assert.equal(app.focused.at(-1), '[data-action="configure"]');
    await click("configure");
    await change("delivery", "immediate");
    assert.doesNotMatch(app.node("#dialog").innerHTML, /<select name="commentConcurrency"[^>]* disabled/);
    await click("dialog-save");
    assert.match(app.node("#top").innerHTML, /Parallelism: 3/);
});

const bundledCatalog = (selected = NAMES) => ({ bundled: true, selected, defaults: { selected, saved: selected !== NAMES }, skills: NAMES.map((name, i) => ({
    name, role: i === 2 ? "ponytail" : "review", title: name, summary: `Summary of ${name}`, modified: false, sha256: "0".repeat(64),
    upstream: { repository: i === 2 ? "https://github.com/DietrichGebert/ponytail" : "https://github.com/addyosmani/agent-skills", release: i === 2 ? "v5.3.3" : "0.6.15", releaseCommit: "1".repeat(40), path: `skills/${name}/SKILL.md`, fileCommit: "abcdef1234567890" },
    license: { spdx: "MIT", files: [] }, attribution: i === 1 ? "Adapted upstream from Anthropic's code-simplifier (Apache-2.0)." : null, selected: selected.includes(name),
})) });

test("Agent review settings has a heading, General and Review skills tabs, no Run button, and bundled skills on by default with provenance", async () => {
    const { app, posts, click } = await skillsApp(bundledCatalog());
    app.state.settings = settingsFixture();
    app.run("renderTop()");
    const top = app.node("#top").innerHTML;
    assert.doesNotMatch(top, /review-skills|Review skills/);
    assert.match(top, /<details class="review-settings-menu"><summary[^>]*>Settings<\/summary>.*data-action="agent-review-configure"[^>]*>Agent review settings/s);
    await click("agent-review-configure");
    await settle();
    let html = app.node("#dialog").innerHTML;
    assert.match(html, /<h2 id="dialog-title">Agent review settings<\/h2>/);
    assert.doesNotMatch(html, /agent-review-start|Run review/, "settings never start a review");
    assert.match(html, /role="tablist"/);
    assert.match(html, /id="review-tab-general"[^>]*aria-selected="true"[^>]*>General/);
    assert.match(html, /id="review-tab-skills"[^>]*aria-selected="false"[^>]*>Review skills/);
    assert.match(html, /id="review-panel-general"[^>]*>/);
    assert.match(html, /id="review-panel-skills"[^>]* hidden>/);
    await app.run("onInput")({ target: { name: "review-models", value: "my-reviewer" } });
    await click("review-tab", { tab: "skills" });
    html = app.node("#dialog").innerHTML;
    assert.match(html, /id="review-panel-general"[^>]* hidden>/);
    assert.match(html, /<legend>Review skills<\/legend>/);
    for (const name of NAMES) assert.match(html, new RegExp(`name="review-skill" value="${name}" checked`));
    assert.match(html, /Bundled with Self-Review: unmodified snapshot of <a href="https:\/\/github.com\/addyosmani\/agent-skills\/blob\/0.6.15\/skills\/code-review-and-quality\/SKILL.md"/);
    assert.match(html, /DietrichGebert\/ponytail v5.3.3<\/a> \(file commit abcdef1\)\. License: MIT/);
    assert.match(html, /Apache-2.0/);
    assert.doesNotMatch(html, /Refresh from host|Agent Finder|Install|review-skills-refresh/);
    assert.deepEqual(app.read("state.dialog.skillNames"), NAMES);
    assert.equal(dialog(app).models, "my-reviewer", "switching tabs keeps unsaved General choices");
    assert.equal(posts.length, 0, "opening settings never saves or starts work");
});

test("header rerenders preserve the open Settings menu and focused menu control", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.state.settings = settingsFixture();
    app.state.agentReviewAvailable = true;

    const focusEvents: string[] = [];
    const summary = Object.assign(new MockElement("SUMMARY"), { focus: () => focusEvents.push("summary") });
    const configure = Object.assign(new MockElement("BUTTON"), {
        dataset: { action: "configure" },
        focus: () => focusEvents.push("configure"),
    });
    const menu = Object.assign(new MockElement("DETAILS"), { open: true });
    menu.contains = (node) => node === summary || node === configure;
    menu.querySelector = (selector) => selector === "summary" ? summary : selector === '[data-action="configure"]' ? configure : null;
    app.node("#top").querySelector = (selector) => selector === ".review-settings-menu" ? menu : null;

    app.document.activeElement = configure;
    app.run("renderTop()");
    assert.equal(menu.open, true, "an unrelated header update does not close Settings");
    assert.equal(focusEvents.at(-1), "configure", "the focused settings action remains usable");

    app.document.activeElement = summary;
    app.run("renderTop()");
    assert.equal(menu.open, true);
    assert.equal(focusEvents.at(-1), "summary", "focus on the Settings summary survives an update");
});

test("bundled skill loading failures keep unsaved choices and can be retried", async () => {
    let fail = true;
    const { app, posts, click } = await skillsApp(bundledCatalog(["ponytail-review"]), { fail: () => fail });
    await click("agent-review-configure");
    await settle();
    await app.run("onInput")({ target: { name: "review-models", value: "my-reviewer" } });
    assert.match(app.node("#dialog").innerHTML, /Host discovery failed.*data-action="review-skills-refresh"[^>]*>Retry/s);
    fail = false;
    await click("review-skills-refresh");
    assert.doesNotMatch(app.node("#dialog").innerHTML, /Host discovery failed|review-skills-refresh/);
    assert.deepEqual(app.read("state.dialog.skillNames"), ["ponytail-review"], "saved skill defaults preselect");
    assert.equal(dialog(app).models, "my-reviewer");
    assert.equal(posts.length, 0);
});

test("skill defaults require explicit opt-in; Save defaults never starts a review and choices reach one-click runs", async () => {
    const defaults = { models: ["model-a", "model-b"], focus: "review", intent: "", skipDialog: true };
    const { app, posts, click } = await skillsApp(bundledCatalog(), { defaults });
    await click("agent-review-configure");
    await settle();
    assert.equal(dialog(app).saveSkillDefaults, false);
    await app.run("onChange")({ target: { name: "review-skill", value: "code-simplification", checked: false } });
    await app.run("onChange")({ target: { name: "review-save-defaults", checked: false } });
    assert.match(app.node("#dialog").innerHTML, /data-action="agent-review-save-defaults" disabled/, "nothing to save without an opt-in");
    await app.run("onChange")({ target: { name: "review-skill-defaults", checked: true } });
    assert.doesNotMatch(app.node("#dialog").innerHTML, /data-action="agent-review-save-defaults" disabled/);
    await click("agent-review-save-defaults");
    assert.deepEqual(posts, [["/api/review-skills", { names: ["code-review-and-quality", "ponytail-review"], saveDefaults: true }]]);
    assert.equal(app.state.dialog, null);
    assert.match(app.node("#toast").textContent, /No review was started/);
    await click("agent-review");
    assert.equal(posts[1][0], "/api/agent-reviews");
    assert.deepEqual(capturedBody(posts, 1).skillNames, ["code-review-and-quality", "ponytail-review"]);
    assert.equal(capturedBody(posts, 1).useDefaults, true);
});

test("Apply for this review stores a per-review skill choice on a fresh profile without saving defaults or starting a review", async () => {
    const { app, posts, click } = await skillsApp(bundledCatalog());
    await click("agent-review-configure");
    await settle();
    let html = app.node("#dialog").innerHTML;
    assert.match(html, /data-action="agent-review-save-defaults" disabled/, "a fresh profile has nothing to save");
    assert.match(html, /data-action="agent-review-apply-skills">Apply for this review/);
    await app.run("onChange")({ target: { name: "review-skill", value: "code-simplification", checked: false } });
    await click("agent-review-apply-skills");
    assert.equal(posts.length, 0, "applying never saves defaults or starts a review");
    assert.equal(app.state.dialog, null);
    assert.deepEqual([...required(app.state.skillOverrides.get("r"))], ["code-review-and-quality", "ponytail-review"]);
    assert.match(app.node("#toast").textContent, /this review only.*no review was started/i);
    await click("agent-review");
    await settle();
    assert.deepEqual(app.read("state.dialog.skillNames"), ["code-review-and-quality", "ponytail-review"], "the run dialog reuses the applied choice");
    await click("agent-review-start");
    assert.deepEqual(posts.map(([url]) => url), ["/api/agent-reviews"]);
    assert.deepEqual(capturedBody(posts, 0).skillNames, ["code-review-and-quality", "ponytail-review"]);
});

test("Run review sends this review's skill opt-outs without saving skill defaults", async () => {
    const { app, posts, click } = await skillsApp(bundledCatalog());
    await click("agent-review");
    await settle();
    assert.match(app.node("#dialog").innerHTML, /<h2 id="dialog-title">Agentic review<\/h2>.*data-action="agent-review-start"/s, "the run dialog keeps its Run button");
    await app.run("onInput")({ target: { name: "review-models", value: "my-reviewer" } });
    for (const name of NAMES) await app.run("onChange")({ target: { name: "review-skill", value: name, checked: false } });
    await app.run("onChange")({ target: { name: "review-skill", value: "ponytail-review", checked: true } });
    await click("agent-review-start");
    assert.deepEqual(posts.map(([url]) => url), ["/api/agent-reviews"]);
    assert.deepEqual(capturedBody(posts, 0).skillNames, ["ponytail-review"]);
    assert.deepEqual(capturedBody(posts, 0).models, ["my-reviewer"]);
    assert.deepEqual([...required(app.state.skillOverrides.get("r"))], ["ponytail-review"]);
});

test("the page provides every container the scope and learning controls render into", async () => {
    const html = await readFile(new URL("../dist/web/index.html", import.meta.url), "utf8");
    for (const id of ["top", "banner", "layout", "side", "main", "ruler", "review-status-controls", "dialog", "toast"]) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.ok(html.indexOf('id="review-status-controls"') < html.indexOf('id="review-status"'), "left footer controls must precede right-aligned refresh status");
});

test("settings and footer controls stay usable above file headers and within the footer", async () => {
    const css = await readFile(new URL("../dist/web/styles.css", import.meta.url), "utf8");
    const settingsMenu = required(css.match(/\.review-settings-options\s*\{([^}]*)\}/s))[1];
    const fileHeader = required(css.match(/\.file-head\s*\{([^}]*)\}/s))[1];
    const footerControls = required(css.match(/\.review-status-controls\s*\{([^}]*)\}/s))[1];
    const zIndex = (rule: string) => Number(required(rule.match(/z-index:\s*(\d+)/))[1]);
    assert.ok(zIndex(settingsMenu) > zIndex(fileHeader), "the settings menu must paint above sticky file headers");
    assert.match(footerControls, /max-height:\s*100%/);
    assert.match(footerControls, /overflow:\s*auto/);
});

test("agent review is opt-in and its dialog collects models, focus, and guidance with optional Addy skills", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.run("renderTop()");
    assert.doesNotMatch(app.node("#top").innerHTML, /data-action="agent-review"/);
    app.state.agentReviewAvailable = true;
    app.state.view = { type: "agent-comments" };
    app.run("renderTop(); renderMain()");
    assert.match(app.node("#top").innerHTML, /data-action="agent-review"[^>]*>Run agentic review/);
    assert.match(app.node("#main").innerHTML, /data-action="agent-review"/);
    const click = clicker(app);
    await click("agent-review");
    const d = required(app.state.dialog);
    assert.equal(d.type, "agent-review");
    assert.equal(d.models, "", "no paid model is implicitly selected");
    assert.equal(d.intent, "");
    assert.equal(d.revisionId, "r1");
    assert.match(app.node("#dialog").innerHTML, /may consume credits/);
    assert.match(app.node("#dialog").innerHTML, /No files are changed until you approve/);
    assert.match(app.node("#dialog").innerHTML, /role="dialog".*aria-modal="true"/);
    assert.match(app.node("#dialog").innerHTML, /Goal, spec, or review guidance \(optional\)/);
    assert.match(app.node("#dialog").innerHTML, /Bundled review skills are unavailable in this build/);
    assert.doesNotMatch(app.node("#dialog").innerHTML, /review-skills-refresh|name="review-skill"/);
    assert.match(app.node("#dialog").innerHTML, /Missing evidence is reported, not treated as a pass/);
    app.run("onInput")({ target: { name: "review-models", value: "model-a, model-b" } });
    app.run("onInput")({ target: { name: "review-intent", value: "Check the documented retry boundary." } });
    await app.run("onChange")({ target: { name: "review-focus", value: "both" } });
    assert.equal(d.models, "model-a, model-b");
    assert.equal(d.focus, "both");
    assert.equal(d.intent, "Check the documented retry boundary.");
    await click("dialog-cancel");
    assert.equal(app.state.dialog, null);
    assert.equal(app.focused.at(-1), '[data-action="agent-review"]');
});

test("built-in reviewer suggestions prefill only without saved or previous choices and never skip the dialog", async () => {
    const posts: string[] = [];
    const app = await loadApp({ fetch: async (url: string) => { posts.push(url); return jsonResponse({}); } });
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSuggestedModels = ["gpt-6-astra", "gpt-6.1-sol", "copilot-fusion"];
    const click = clicker(app);
    await click("agent-review");
    assert.equal(dialog(app).models, "gpt-6-astra, gpt-6.1-sol, copilot-fusion");
    assert.equal(dialog(app).saveDefaults, false, "suggestions are not saved choices");
    assert.equal(dialog(app).skipDialog, false);
    assert.match(app.node("#dialog").innerHTML, /copilot-fusion to run Copilot Fusion in a child session/);
    assert.equal(posts.length, 0, "suggestions never start a review");
    await click("dialog-cancel");
    app.state.review = reviewFixture({ agentReviews: [{ runId: "ar-last", state: "completed", focus: "simplify", models: ["model-last"], results: [] }] });
    await click("agent-review");
    assert.equal(dialog(app).models, "model-last", "the previous run wins over suggestions");
    await click("dialog-cancel");
    app.state.agentReviewSettings = { models: ["model-saved"], focus: "both", intent: "", skipDialog: false };
    await click("agent-review");
    assert.equal(dialog(app).models, "model-saved", "saved defaults win over the previous run");
    await click("dialog-cancel");
    app.state.review = reviewFixture({ agentReviews: [{ runId: "ar-fusion", state: "running", focus: "both", revisionId: "r1", models: ["model-a", "copilot-fusion"], results: [] }] });
    const html = app.run("agentReviewsHtml()");
    assert.match(html, /copilot-fusion<\/span>: Awaiting result from the Copilot Fusion child session/);
    assert.match(html, /model-a<\/span>: Awaiting result</);
    assert.equal(posts.length, 0);
});

test("the prominent review action and agent-comment counts include findings, not human threads or replies", async () => {
    const app = await loadApp();
    const thread = (id: string, status: string, revisionId: string) => ({
        threadId: id, kind: "overview", status,
        agentReview: { runId: "ar-one", model: "model-a", revisionId, assessment: "unverified" },
        messages: [{ messageId: id, author: "agent", body: "Finding", createdAt: "2026-01-01" },
            { messageId: `${id}-reply`, author: "user", body: "Discuss", createdAt: "2026-01-01" }],
    });
    app.state.review = reviewFixture({ threads: [thread("one", "active", "r1"), thread("two", "resolved", "r0"),
        { threadId: "manual", kind: "overview", status: "active", messages: [{ author: "agent", body: "Reply to human feedback" }] }] });
    app.state.agentReviewAvailable = true;
    app.state.busy = false;
    app.state.settings = settingsFixture();
    app.run("renderTop(); renderSide()");
    const html = app.node("#top").innerHTML;
    assert.doesNotMatch(html, /review-lane|Agentic review|Manual Review/);
    assert.match(html, /aria-label="Change context".*Copilot idle.*Refresh/);
    assert.match(html, /data-action="agent-review"[^>]*>Run agentic review/);
    assert.match(html, /<summary[^>]*>Settings<\/summary>/);
    assert.match(html, /data-action="configure"[^>]*>Manual review settings.*data-action="agent-review-configure"[^>]*>Agent review settings/s);
    assert.match(html, /<span class="spacer"><\/span>.*data-action="agent-review".*review-settings-menu.*data-action="refresh"/s);
    assert.match(html, /change-context-heading.*Revision captured 2026.*r1 · 2 files.*<\/div><div class="change-context-details">/s);
    assert.doesNotMatch(html, /data-scope=/, "the scope toggle moved out of the header");
    assert.doesNotMatch(html, /Agent comments|agent-comment-count|data-view="agent-comments"/);
    assert.doesNotMatch(html, /Delivery:|Auto-save learned rules:/);
    app.run("renderLoadStatus()");
    assert.doesNotMatch(app.node("#review-status-controls").innerHTML, /Delivery:|Auto-save learned rules:/, "preferences live in Settings, not the status bar");
    const side = app.node("#side").innerHTML;
    assert.match(side, /data-view="overview".*<span class="count"[^>]*>2<\/span><span class="name">Agent reviews<\/span>/);
    assert.match(side, /Files \(\d+\)<\/div><div class="tree-scope"><span class="seg" role="group" aria-label="Review scope">.*data-scope="all".*data-scope="pending"/s);
    assert.doesNotMatch(app.run("overviewView()"), /agent-review-run|Review runs|<h2>Revisions/, "Overview omits agent review runs and the revisions list");
    assert.match(app.run("agentCommentsView()"), /1 active, 1 closed or resolved; 1 from older revisions/);
    assert.match(app.run("agentCommentsView()"), /<div class="agent-reviews-heading"><h2>Agent reviews<\/h2><button class="primary agent-review-launch"[^>]*>Run agentic review/);
    assert.doesNotMatch(app.run("agentCommentsView()"), /Reply to human feedback/);
    await clicker(app)("nav", { view: "agent-comments" });
    assert.equal(required(app.state.view).type, "agent-comments");
    assert.match(app.node("#main").innerHTML, /<h2>Agent reviews<\/h2>.*Agent comments \(<span aria-live="polite">2<\/span>\)/);
    app.state.review = reviewFixture({ agentReviews: [{ runId: "ar-running", state: "running", focus: "review", revisionId: "r1", models: ["model-a"], results: [] }] });
    app.run("renderTop()");
    assert.match(app.node("#top").innerHTML, /data-action="agent-review"[^>]*disabled>Agentic review running/);
    assert.match(app.run("agentCommentsView()"), /data-action="agent-review"[^>]*disabled>Agentic review running/);
    assert.equal(app.run("agentComments().length"), 0, "scope switches never carry another scope's counts");
});

test("saved user choices prefill configuration and save-only never starts a review", async () => {
    const posts: CapturedPost[] = [];
    const defaults = { models: ["model-a"], focus: "both", intent: "Check contracts.", skipDialog: true };
    const app = await loadApp({
        fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            posts.push([url, requestBody(opts)]);
            return jsonResponse(requestBody(opts).defaults);
        },
    });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettingsAvailable = true;
    app.state.agentReviewSettings = defaults;
    await clicker(app)("agent-review-configure");
    assert.equal(dialog(app).models, "model-a");
    assert.equal(dialog(app).intent, "Check contracts.");
    assert.equal(dialog(app).skipDialog, true);
    assert.match(app.node("#dialog").innerHTML, /User defaults for all repositories/);
    await app.run("onChange")({ target: { name: "review-skip-dialog", checked: false } });
    await clicker(app)("agent-review-save-defaults");
    assert.deepEqual(posts, [["/api/agent-review-settings", { defaults: { ...defaults, skipDialog: false } }]]);
    assert.equal(app.state.dialog, null);
    assert.equal(required(app.state.agentReviewSettings).skipDialog, false);
    await clicker(app)("agent-review");
    assert.equal(dialog(app).type, "agent-review", "disabling one-click brings back the dialog");
    assert.equal(posts.length, 1, "opening configuration never launches work");
});

test("one-click run skips the dialog, uses the current revision, and guards repeated clicks", async () => {
    let finish: (() => void) | undefined;
    const posts: CapturedPost[] = [];
    const app = await loadApp({ fetch: async (url: string, opts?: { method?: string; body?: string }) => {
        posts.push([url, requestBody(opts)]);
        return new Promise((resolve) => { finish = () => resolve(jsonResponse({ state: "queued" })); });
    } });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettings = { models: ["model-a", "model-b"], focus: "both", intent: "", skipDialog: true };
    const first = clicker(app)("agent-review");
    await clicker(app)("agent-review");
    assert.equal(app.state.dialog, null);
    assert.equal(app.state.startingReview, true);
    assert.deepEqual(posts, [["/api/agent-reviews", { useDefaults: true, oneClick: true, revisionId: "r1" }]]);
    required(finish)();
    await first;
    assert.equal(app.state.startingReview, false);
});

test("legacy one-model defaults open the dialog instead of starting a review", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettings = { models: ["model-a"], focus: "both", skipDialog: true };
    await clicker(app)("agent-review");
    assert.equal(dialog(app).models, "model-a");
    assert.match(app.node("#dialog").innerHTML, /two to four model IDs/);
});

test("one-click run reloads defaults and requires the same scope and revision", async () => {
    const app = await loadApp();
    app.run("renderRuler = () => {};");
    app.run('loadState = async () => { state.agentReviewSettings = { models: ["updated-model"], focus: "review", skipDialog: false }; }');
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettings = { models: ["stale-model", "model-b"], focus: "both", skipDialog: true };
    await clicker(app)("agent-review");
    assert.equal(app.state.dialog?.type, "agent-review");
    assert.equal(dialog(app).models, "updated-model");
    assert.equal(app.state.startingReview, false);

    app.state.dialog = null;
    app.state.agentReviewSettings = { models: ["model-a", "model-b"], focus: "both", skipDialog: true };
    app.run('loadState = async () => { state.review = { ...state.review, reviewId: "other-scope" }; }');
    await clicker(app)("agent-review");
    assert.equal(app.state.dialog, null);
    assert.equal(app.state.startingReview, false);
    assert.match(app.node("#toast").textContent, /scope or revision changed/);

    app.state.review = reviewFixture();
    app.state.agentReviewSettings = { models: ["model-a", "model-b"], focus: "both", skipDialog: true };
    app.run('loadState = async () => { state.review = { ...state.review, currentRevisionId: "r2" }; }');
    await clicker(app)("agent-review");
    assert.equal(app.state.dialog, null);
    assert.equal(app.state.startingReview, false);
    assert.match(app.node("#toast").textContent, /scope or revision changed/);
});

test("saving defaults during a scope or revision change does not start an unconfirmed review", async () => {
    for (const change of [
        { reviewId: "other-scope", currentRevisionId: "other-r1" },
        { reviewId: "r", currentRevisionId: "r2" },
    ]) {
        let app: LoadedApp;
        const posts: CapturedPost[] = [];
        app = await loadApp({ fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            posts.push([url, requestBody(opts)]);
            app.state.review = reviewFixture(change);
            return jsonResponse({ models: ["model-a"], focus: "both", intent: "", skipDialog: true });
        } });
        app.run("loadState = async () => {}");
        app.state.review = reviewFixture();
        app.state.agentReviewAvailable = true;
        app.state.agentReviewSettingsAvailable = true;
        app.run("openAgentReview()");
        dialog(app).models = "model-a";
        dialog(app).saveDefaults = true;
        await app.run("startAgentReview()");
        assert.deepEqual(posts.map(([url]) => url), ["/api/agent-review-settings"]);
        assert.match(required(dialog(app).error), /scope changed or revision is stale/);
        assert.equal(dialog(app).saving, false);
    }
});

test("saving user defaults remains available after the review scope or revision changes", async () => {
    for (const change of [
        { reviewId: "other-scope", currentRevisionId: "other-r1" },
        { reviewId: "r", currentRevisionId: "r2" },
    ]) {
        const posts: CapturedPost[] = [];
        const app = await loadApp({ fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            posts.push([url, requestBody(opts)]);
            return jsonResponse({ models: ["model-a"], focus: "both", intent: "", skipDialog: false });
        } });
        app.run("loadState = async () => {}");
        app.state.review = reviewFixture();
        app.state.agentReviewAvailable = true;
        app.state.agentReviewSettingsAvailable = true;
        app.run("openAgentReview()");
        dialog(app).models = "model-a";
        dialog(app).saveDefaults = true;
        app.state.review = reviewFixture(change);
        await app.run("startAgentReview(true)");
        assert.deepEqual(posts, [["/api/agent-review-settings", {
            defaults: { models: ["model-a"], focus: "review", intent: "", skipDialog: false },
        }]]);
        assert.equal(app.state.dialog, null);
        assert.match(app.node("#toast").textContent, /User defaults saved\. No review was started/);
    }
});

test("one-click failures surface errors and release the button even if reloading state fails", async () => {
    for (const reloadFails of [false, true]) {
        const app = await loadApp({ fetch: async () => jsonResponse({ error: { message: "Review could not be queued" } }, 500) });
        app.run("renderRuler = () => {};");
        app.run(reloadFails
            ? 'window.loadCount = 0; loadState = async () => { window.loadCount++; if (window.loadCount > 1) throw new Error("State reload failed"); renderMain(); }'
            : "loadState = async () => { renderMain(); }");
        app.state.review = reviewFixture();
        app.state.view = { type: "agent-comments" };
        app.state.agentReviewAvailable = true;
        app.state.agentReviewSettings = { models: ["model-a", "model-b"], focus: "both", skipDialog: true };
        if (reloadFails) {
            app.state.snapshot = { revisionId: "r1", files: [] };
            app.run('pinnedComposers.set("preserved-draft", { kind: "file", path: "src/a.ts", revisionId: "r1" })');
        }
        app.run("renderMain()");
        app.node("#main").scrollTop = 42;
        await clicker(app)("agent-review");
        assert.equal(app.state.startingReview, false);
        assert.equal(app.state.dialog, null);
        const reviews = app.node("#main").innerHTML;
        assert.match(reviews, /data-action="agent-review"[^>]*>Run agentic review/);
        assert.doesNotMatch(reviews, /data-action="agent-review"[^>]*disabled/);
        assert.equal(app.node("#main").scrollTop, 42, "redrawing the launcher preserves the current main-view scroll position");
        assert.equal(app.node("#toast").textContent, reloadFails ? "State reload failed" : "Review could not be queued");
        assert.match(app.node("#toast").className, /error/);
        if (reloadFails) assert.match(reviews, /data-composer="preserved-draft"/, "pinned comment drafts remain visible after the failed reload");
    }
});

test("failed settings saves stay visible and never start a review", async () => {
    const posts: string[] = [];
    const app = await loadApp({ fetch: async (url: string) => {
        posts.push(url);
        return jsonResponse({ error: { message: "Disk is read-only" } }, 500);
    } });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettingsAvailable = true;
    app.run("openAgentReview()");
    dialog(app).models = "model-a";
    dialog(app).saveDefaults = true;
    await app.run("startAgentReview()");
    assert.deepEqual(posts, ["/api/agent-review-settings"]);
    assert.match(app.node("#dialog").innerHTML, /role="alert">Disk is read-only/);
    assert.equal(dialog(app).saving, false);
});

test("an unreadable profile exposes its error instead of silently running different choices", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettingsError = "Could not read agent review defaults: invalid JSON";
    await clicker(app)("agent-review");
    assert.match(app.node("#dialog").innerHTML, /role="alert">Could not read agent review defaults/);
    assert.equal(dialog(app).models, "");
});

test("agent review traps keyboard focus including guidance and the optional skill link while queuing", async () => {
    const app = await loadApp();
    app.state.dialog = { type: "agent-review", saving: false };
    const focus: string[] = [];
    const input = { focus: () => focus.push("models") };
    const guidance = { focus: () => focus.push("guidance") };
    const link = { focus: () => focus.push("skills") };
    const button = { focus: () => focus.push("run") };
    app.document.querySelectorAll = (selector: string) => {
        assert.match(selector, /#dialog textarea:not\(\[disabled\]\)/);
        assert.match(selector, /#dialog a\[href\]/);
        return dialog(app).saving ? [link] : [input, guidance, link, button];
    };
    let prevented = 0;
    const press = (shiftKey: boolean) => app.run("trapTab")({ shiftKey, preventDefault: () => prevented++ });
    app.document.activeElement = input;
    press(true);
    app.document.activeElement = button;
    press(false);
    app.document.activeElement = guidance;
    press(false);
    assert.deepEqual(focus, ["run", "models"]);
    assert.equal(prevented, 2);
    dialog(app).saving = true;
    app.document.activeElement = link;
    press(false);
    press(true);
    assert.deepEqual(focus, ["run", "models", "skills", "skills"]);
    assert.equal(prevented, 4);
});

test("agent review start sends selected models and pinned revision and preserves errors in the dialog", async () => {
    const posts: CapturedPost[] = [];
    const app = await loadApp({
        fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            if (opts?.method === "POST") {
                posts.push([url, requestBody(opts)]);
                return jsonResponse({ error: { message: "Selected model unavailable" } }, 400);
            }
            return jsonResponse({ review: reviewFixture(), agentReviewAvailable: true });
        },
    });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.run("openAgentReview()");
    dialog(app).models = "model-a, model-b";
    dialog(app).focus = "both";
    dialog(app).intent = "Use Addy's skills if installed.";
    await app.run("startAgentReview()");
    assert.deepEqual(posts, [["/api/agent-reviews", { models: ["model-a", "model-b"], focus: "both", intent: "Use Addy's skills if installed.", revisionId: "r1" }]]);
    assert.equal(dialog(app).saving, false);
    assert.match(app.node("#dialog").innerHTML, /role="alert">Selected model unavailable/);
    app.state.review.reviewId = "different-scope";
    await app.run("startAgentReview()");
    assert.equal(posts.length, 1, "an old dialog must not launch into the newly selected scope");
    assert.match(required(dialog(app).error), /scope changed/);
});

test("agent review results distinguish findings, assessments, limits, and missing or failed model outcomes", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture({
        agentReviews: [{
            runId: "ar-one", state: "running", focus: "both", revisionId: "r0",
            intent: "<goal>",
            models: ["model-a", "<bad-model>", "model-c", "model-d"],
            results: [
                { model: "model-a", state: "completed", threadIds: [], summary: "<coverage>: spec unavailable; tests not run." },
                { model: "<bad-model>", state: "failed", error: "<failed>" },
                { model: "model-d", state: "completed", threadIds: ["t1", "t2", "t3", "t4"] },
            ],
        }],
        threads: [
            { threadId: "t1", agentReview: { assessment: "confirmed" } },
            { threadId: "t2", agentReview: { assessment: "pre-existing" } },
            { threadId: "t3", agentReview: { assessment: "rejected" } },
            { threadId: "t4", agentReview: {} },
        ],
    });
    const html = app.run("agentReviewsHtml()");
    assert.match(html, /model-a<\/span>: No findings reported/);
    assert.match(html, /&lt;bad-model&gt;<\/span>: Failed: &lt;failed&gt;/);
    assert.match(html, /model-c<\/span>: Awaiting result/);
    assert.match(html, /model-d<\/span>: 1 confirmed, 1 pre-existing, 1 rejected, 1 unverified/);
    assert.match(html, /&lt;coverage&gt;: spec unavailable; tests not run/);
    assert.match(html, /Goal \/ spec \/ guidance: &lt;goal&gt;/);
    assert.match(html, /No coverage or verification summary recorded/);
    assert.match(html, /older diff/);
    assert.match(html, /does not stop agents already running/);
    assert.doesNotMatch(html, /<bad-model>|<failed>|<coverage>|<goal>/);
});

test("Ponytail run details retain each contributing model's wording and evidence", async () => {
    const app = await loadApp();
    const models = ["model-a", "model-b"];
    app.state.review = reviewFixture({
        agentReviews: [{
            runId: "ar-one", state: "completed", focus: "both", revisionId: "r1", protocol: "consensus-v1", models,
            results: models.map((model, index) => ({
                model, state: "completed", threadIds: [], summary: "Inspected the diff.",
                ponytail: { status: "used", summary: "Checked opportunities.", benefits: [{
                    proposal: `Proposal ${index}`, benefit: `Benefit ${index}`,
                    evidence: { source: `Source ${index}`, baseline: `Baseline ${index}`, validation: `Validation ${index}` },
                }] },
            })),
            consensus: [{
                kind: "ponytail", sources: models.map((model) => ({ model, index: 0 })),
                votes: models.map((model) => ({ model, decision: "agree", discussion: "Discussed.", rationale: "Supported." })),
            }],
        }],
    });
    const html = app.run("agentReviewsHtml()");
    for (const index of [0, 1]) {
        for (const field of ["Proposal", "Benefit", "Source", "Baseline", "Validation"]) {
            assert.match(html, new RegExp(`${field} ${index}`));
        }
    }
});

test("Ponytail run details label and retain agreed, disputed, pending, and incomplete evidence", async () => {
    const app = await loadApp();
    const benefit = (label: string) => ({
        proposal: `${label} proposal`, benefit: `${label} benefit`,
        evidence: { source: `${label} source`, baseline: `${label} baseline`, validation: `${label} validation` },
    });
    const result = (benefits: ReturnType<typeof benefit>[]) => ({
        model: "model-a", state: "completed", threadIds: [], summary: "Inspected.",
        ponytail: { status: "used", summary: "Checked opportunities.", benefits },
    });
    const votes = (decision: string) => [
        { model: "model-a", decision: "agree", discussion: "Discussed.", rationale: "Supported." },
        { model: "model-b", decision, discussion: "Discussed.", rationale: "Reviewed." },
    ];
    app.state.review = reviewFixture({ agentReviews: [
        { runId: "completed", state: "completed", focus: "both", revisionId: "r1", protocol: "consensus-v1",
            models: ["model-a", "model-b"], results: [result([benefit("Agreed"), benefit("Disputed")])],
            consensus: [
                { kind: "ponytail", sources: [{ model: "model-a", index: 0 }], votes: votes("agree") },
                { kind: "ponytail", sources: [{ model: "model-a", index: 1 }], votes: votes("disagree") },
            ] },
        { runId: "running", state: "running", focus: "both", revisionId: "r1", protocol: "consensus-v1",
            models: ["model-a"], results: [result([benefit("Pending")])] },
        { runId: "partial", state: "partial", focus: "both", revisionId: "r1", protocol: "consensus-v1",
            models: ["model-a"], results: [result([benefit("Incomplete")])] },
    ] });
    const html = app.run("agentReviewsHtml()");
    assert.match(html, /Ponytail: 1 agreed opportunities/);
    for (const [label, status] of [["Agreed", "Agreed"], ["Disputed", "Not agreed (not published)"], ["Pending", "Awaiting consensus (not published)"], ["Incomplete", "Not finalized (not published)"]]) {
        const start = html.indexOf(`${label} proposal`);
        assert.notEqual(start, -1, `${label} proposal is visible`);
        const entry = html.slice(start, html.indexOf("</div>", start));
        assert.match(entry, new RegExp(`${label} source`));
        assert.match(entry, new RegExp(`${label} baseline`));
        assert.match(entry, new RegExp(`${label} validation`));
        assert.ok(entry.includes(status), `${label} is labeled ${status}`);
    }
});

test("agreed finding exposes all reviewer evidence and votes without treating them as HTML", async () => {
    const app = await loadApp();
    const html = app.run<(finding: unknown) => string>("findingEvidenceHtml")({
        model: "model-a", category: "issue", assessment: "confirmed", severity: "required",
        runId: "run", revisionId: "r1", evidence: { source: "source", baseline: "base", validation: "checked" },
        contributions: [
            { model: "model-a", body: "Original", evidence: { source: "source", baseline: "base", validation: "checked" } },
            { model: "model-b", body: "<script>alert(1)</script>", evidence: { source: "other", baseline: "old", validation: "verified" },
                assessment: "confirmed", severity: "optional", anchor: { revisionId: "r1", path: "a.ts", side: "new", startLine: 2, endLine: 3 } },
        ],
        votes: [{ model: "model-b", decision: "agree", discussion: "<discussion>", rationale: "<reason>" }],
    });
    assert.match(html, /model-a/);
    assert.match(html, /model-b/);
    assert.match(html, /confirmed \/ optional/);
    assert.match(html, /a\.ts.*new.*2/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;discussion&gt;/);
    assert.doesNotMatch(html, /<script>|<discussion>|<reason>/);
});

test("FYI contribution disables approval even when the grouped severity is actionable", async () => {
    const app = await loadApp();
    const issue = app.run<(finding: unknown) => string>("findingApprovalIssue")({
        assessment: "confirmed", severity: "required",
        evidence: { source: "source", baseline: "baseline", validation: "validation" },
        contributions: [{ model: "model-b", severity: "fyi", evidence: { source: "source", baseline: "baseline", validation: "validation" } }],
    });
    assert.match(issue, /FYI/);
});

test("model findings have Approve and Discuss controls; stale, closed, and approved findings cannot be approved again", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const thread: {
        threadId: string;
        kind: string;
        status: string;
        messages: Array<{ messageId: string; author: string; body: string; createdAt: string }>;
        agentReview?: {
            model: string;
            category: string;
            revisionId: string;
            assessment: string | undefined;
            severity: string;
            evidence: { source: string; baseline: string; validation: string };
            approvalMessageId?: string;
        };
    } = {
        threadId: "t-model", kind: "overview", status: "active", messages: [{ messageId: "m", author: "agent", body: "A suggestion", createdAt: new Date().toISOString() }],
        agentReview: {
            model: "<model>", category: "simplification", revisionId: "r1", assessment: "confirmed", severity: "optional",
            evidence: { source: "source <unsafe>", baseline: "The old flow has the same behavior.", validation: "Compared side effects; no tests run." },
        },
    };
    const html = () => app.run(`threadHtml(${JSON.stringify(thread)})`);
    const finding = required(thread.agentReview);
    assert.match(html(), /&lt;model&gt; \/ simplification/);
    assert.match(html(), /data-action="approve-finding"[^>]*>Approve/);
    assert.match(html(), /data-action="discuss-finding"/);
    assert.match(html(), /Agent assessment|Assessment reported by the coordinating agent/);
    assert.match(html(), />Confirmed<\/span>/);
    assert.match(html(), />Optional<\/span>/);
    assert.match(html(), /Evidence and verification/);
    assert.match(html(), /source &lt;unsafe&gt;/);
    assert.doesNotMatch(html(), /<unsafe>/);
    for (const assessment of ["pre-existing", "rejected", "unverified", undefined]) {
        finding.assessment = assessment;
        assert.match(html(), /data-action="approve-finding"[^>]*disabled/, `${assessment} is not approvable`);
        assert.match(html(), /data-action="discuss-finding"/);
    }
    finding.assessment = "confirmed";
    finding.severity = "fyi";
    assert.match(html(), /data-action="approve-finding"[^>]*disabled/);
    finding.severity = "optional";
    finding.evidence.baseline = "";
    assert.match(html(), /data-action="approve-finding"[^>]*disabled/);
    finding.evidence.baseline = "Compared both sides.";
    finding.revisionId = "r0";
    assert.match(html(), /data-action="approve-finding"[^>]*disabled/);
    finding.revisionId = "r1";
    finding.approvalMessageId = "approved";
    assert.match(html(), /disabled>Approved/);
    delete finding.approvalMessageId;
    thread.status = "closed";
    assert.match(html(), /data-action="approve-finding"[^>]*disabled/);
    delete thread.agentReview;
    assert.doesNotMatch(html(), /approve-finding|discuss-finding/);
});

test("Discuss only opens a composer; Approve explicitly sends the finding and reports delivery failure", async () => {
    const posts: CapturedPost[] = [];
    const app = await loadApp({
        fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            posts.push([url, requestBody(opts)]);
            return jsonResponse({ error: "transport unavailable" });
        },
    });
    app.run("render = () => {}; loadState = async () => {}; focusComposer = (key) => { state.focusedComposer = key; }");
    app.state.review = reviewFixture();
    const click = clicker(app);
    await click("discuss-finding", { thread: "t1" });
    assert.deepEqual(posts, [], "opening a discussion sends nothing");
    assert.equal(app.state.open.has("reply:t1"), true);
    assert.equal(app.state.focusedComposer, "reply:t1");
    await click("approve-finding", { thread: "t1" });
    assert.deepEqual(posts, [["/api/threads/t1/approve", { revisionId: "r1" }]]);
    assert.match(app.node("#toast").textContent, /delivery failed: transport unavailable/);
    assert.equal(app.state.approving.size, 0);
});

test("file views show mode changes and side-specific EOF notes without selectable phantom lines", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const diff = "diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 100755\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n";
    const [file] = parseUnifiedDiff(diff);
    app.state.files = [file];
    const html = app.run(`fileView(${JSON.stringify(file)}, { stacked: true })`);
    assert.match(html, /File mode: 100644 to 100755/);
    assert.match(html, /class="eof-note".*No newline at end of file \(old side\)/);
    assert.equal((html.match(/<tr class="row /g) ?? []).length, 2);
    const note = required(html.match(/<tr class="eof-note">.*?<\/tr>/))[0];
    assert.doesNotMatch(note, /data-h=|data-i=/, "EOF metadata does not change source row indices or selection");
    file.hunks[0].rows[0].noNewlineAtEnd = false;
    file.hunks[0].rows[1].noNewlineAtEnd = true;
    assert.match(app.run(`fileView(${JSON.stringify(file)}, { stacked: true })`), /No newline at end of file \(new side\)/);
    file.hunks = [];
    assert.match(app.run(`fileView(${JSON.stringify(file)}, { stacked: true })`), /File mode: 100644 to 100755/);
});

test("loads nullable values from review state and labels unavailable upstream counts", async () => {
    let review: unknown = reviewFixture({
        scope: "pending",
        base: null,
        currentRevisionId: null,
        revisions: [],
        git: { branch: "feature", headCommit: "abc", baseCommit: null, upstream: { name: "origin/feature", ahead: null, behind: null }, uncommittedFiles: 0 },
        description: { version: 1, revisionId: null, body: "Draft" },
    });

    const app = await loadApp({
        fetch: async (url: string) => {
            if (url === "/api/state") return jsonResponse({ review, session: { busy: null }, settings: settingsFixture() });
            if (url === "/api/snapshot/r1") return jsonResponse({ revisionId: "r1", files: [] });
            throw new Error(`unexpected request ${url}`);
        },
    });
    app.run("render = () => {}");

    await app.run("loadState()");
    assert.equal(app.state.review.base, null);
    assert.equal(app.state.busy, null);
    assert.deepEqual(app.state.review.description, { version: 1, revisionId: null, body: "Draft" });

    review = reviewFixture({
        git: { branch: "feature", headCommit: "abc", baseCommit: "def", upstream: { name: "origin/feature", ahead: null, behind: null }, uncommittedFiles: 0 },
    });
    await app.run("loadState()");
    app.run("renderTop()");
    assert.match(app.node("#top").innerHTML, /↑\? ↓\?/);
});

test("revision reload preserves composer text and posts a changed-line draft against its original revision", async () => {
    const posts: Record<string, unknown>[] = [];
    const app = await loadApp({
        CSS: { escape: (value: string) => value },
        fetch: async (url: string, options?: { method?: string; body?: string }) => {
            if (options?.method === "POST") {
                posts.push(requestBody(options));
                return jsonResponse({ threadId: "posted" });
            }
            if (url === "/api/state") return jsonResponse({ review: reviewFixture({ currentRevisionId: "r2" }), settings: settingsFixture() });
            if (url === "/api/snapshot/r2") return jsonResponse({ revisionId: "r2", files: [] });
            throw new Error(`unexpected request ${url}`);
        },
    });
    app.state.review = reviewFixture();
    app.state.settings = settingsFixture();
    const key = "line:file.ts:new:2-2";
    const textarea = { value: "unfinished feedback", dataset: { composer: key }, focus() {} };
    const box = Object.assign(new MockElement(), {
        dataset: { key, kind: "line", path: "file.ts", side: "new", start: "2", end: "2", revision: "r1" },
        querySelector: (selector: string) => selector === "textarea" ? textarea : { textContent: "Comment on L2" },
    });
    app.document.querySelectorAll = () => [box];
    app.document.querySelector = (selector: string) => selector.startsWith(".composer") ? box : app.node(selector);
    app.run(`composerHtml("hidden-change", { kind: "change", path: "other.ts", side: "new", startLine: 4, endLine: 4, alwaysOpen: true }); setDraft("hidden-change", "another unfinished comment")`);
    app.run("render = () => {}; state.selection = { path: 'file.ts', hunk: 0, from: 1, to: 1, anchor: 1, full: false }");
    await app.run("loadState()");
    assert.equal(app.state.review.currentRevisionId, "r2");
    assert.equal(app.state.selection, null, "old row indices are never reused on the new diff");
    const pinnedKey = `pinned:r1:${key}`;
    assert.equal(app.run(`getDraft(${JSON.stringify(pinnedKey)})`), "unfinished feedback");
    assert.equal(textarea.dataset.composer, pinnedKey, "focus follows the migrated draft");
    assert.equal(app.run(`getDraft(${JSON.stringify(key)})`), "", "the current revision can reuse the same selection");
    const pinned = app.run(`composerHtml(${JSON.stringify(pinnedKey)}, pinnedComposers.get(${JSON.stringify(pinnedKey)}))`);
    assert.match(pinned, /data-revision="r1"/);
    assert.match(pinned, /unfinished feedback/);
    const hidden = app.run(`composerHtml("pinned:r1:hidden-change", pinnedComposers.get("pinned:r1:hidden-change"))`);
    assert.match(hidden, /data-revision="r1"/);
    assert.match(hidden, /another unfinished comment/);
    const current = app.run(`composerHtml(${JSON.stringify(key)}, { kind: "line", path: "file.ts", startLine: 2, endLine: 2, alwaysOpen: true })`);
    assert.match(current, /data-revision="r2"/);
    await app.run(`submit(${JSON.stringify(pinnedKey)})`);
    assert.equal(posts[0].revisionId, "r1");
    assert.equal(posts[0].body, "unfinished feedback");
    assert.equal(app.read("pinnedComposers.size"), 1);
    app.run(`closeComposer("pinned:r1:hidden-change", true)`);
    assert.equal(app.read("pinnedComposers.size"), 0);
});

test("refresh drops empty selection contexts and pins later hidden drafts to the revision they were written against", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const options = `{ kind: "line", path: "file.ts", side: "new", startLine: 2, endLine: 2, alwaysOpen: true }`;
    app.run(`composerHtml("line:file.ts:new:2-2", ${options}); pinComposers()`);
    assert.equal(app.read("pinnedComposers.size"), 0);
    assert.equal(app.read("composerContexts.size"), 0);
    app.state.review.currentRevisionId = "r2";
    app.run(`composerHtml("line:file.ts:new:2-2", ${options}); setDraft("line:file.ts:new:2-2", "feedback on r2"); pinComposers()`);
    assert.equal(app.read(`pinnedComposers.get("pinned:r2:line:file.ts:new:2-2").revisionId`), "r2");
    app.state.review.currentRevisionId = "r3";
    assert.match(app.run(`composerHtml("line:file.ts:new:2-2", ${options})`), /data-revision="r3"/);
});

test("refresh does not pin empty visible composers and keeps file drafts visible when a file leaves the diff", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.state.settings = settingsFixture();
    const empty = { value: "", dataset: { composer: "line:file.ts:new:2-2" } };
    const box = Object.assign(new MockElement(), {
        dataset: { key: empty.dataset.composer, kind: "line", path: "file.ts", side: "new", start: "2", end: "2", revision: "r1" },
        querySelector: (selector: string) => selector === "textarea" ? empty : null,
    });
    app.document.querySelectorAll = () => [box];
    app.run(`composerHtml("file:gone.ts", { kind: "file", path: "gone.ts", alwaysOpen: true }); setDraft("file:gone.ts", "keep this file comment"); pinComposers()`);
    assert.equal(app.read("pinnedComposers.size"), 1, "only the nonempty hidden file draft is pinned");
    app.state.review.currentRevisionId = "r2";
    app.run(`state.snapshot = { revisionId: "r2", files: [] }; state.view = { type: "file", path: "gone.ts" }; renderRuler = () => {}; render()`);
    assert.equal(app.read("state.view.type"), "overview");
    assert.match(app.node("#main").innerHTML, /keep this file comment/);
    assert.match(app.node("#main").innerHTML, /data-kind="file".*data-path="gone.ts"/);
});

test("an in-flight submission completes the migrated draft without deleting a new current-revision draft", async () => {
    let finishPost: (value: unknown) => void = () => { throw new Error("POST not started"); };
    const app = await loadApp({
        CSS: { escape: (value: string) => value },
        fetch: async (_url: string, options?: { method?: string; body?: string }) => {
            assert.equal(options?.method, "POST");
            return new Promise((resolve) => { finishPost = resolve; });
        },
    });
    app.state.review = reviewFixture();
    const textarea = { value: "sending original", dataset: { composer: "line:file.ts:new:2-2" } };
    const box = Object.assign(new MockElement(), {
        dataset: { key: textarea.dataset.composer, kind: "line", path: "file.ts", side: "new", start: "2", end: "2", revision: "r1" },
        querySelector: (selector: string) => selector === "textarea" ? textarea : null,
    });
    app.document.querySelectorAll = () => [box];
    app.document.querySelector = (selector: string) => selector.startsWith(".composer") ? box : app.node(selector);
    app.run("render = () => {}; loadState = async () => {}");
    const submitted = app.run<Promise<void>>(`submit("line:file.ts:new:2-2")`);
    app.run(`pinComposers(); state.review.currentRevisionId = "r2"; setDraft("line:file.ts:new:2-2", "new feedback")`);
    finishPost(jsonResponse({}));
    await submitted;
    assert.equal(app.read("pinnedComposers.size"), 0);
    assert.equal(app.run(`getDraft("line:file.ts:new:2-2")`), "new feedback");
});

test("a completed send cannot clear text or image drafts after switching reviews", async () => {
    let finishPost: (value: unknown) => void = () => { throw new Error("POST not started"); };
    const app = await loadApp({
        CSS: { escape: (value: string) => value },
        fetch: async () => new Promise((resolve) => { finishPost = resolve; }),
    });
    app.state.review = reviewFixture();
    const textarea = { value: "Original text", dataset: { composer: "overview:new" } };
    const box = Object.assign(new MockElement(), {
        dataset: { key: "overview:new", kind: "overview" },
        querySelector: (selector: string) => selector === "textarea" ? textarea : null,
    });
    app.document.querySelector = (selector: string) => selector.startsWith(".composer") ? box : app.node(selector);
    app.run(`render = () => {}; loadState = async () => {}; setDraftImages("overview:new", ["original-image"])`);
    const submitted = app.run<Promise<void>>(`submit("overview:new")`);
    app.state.review = reviewFixture({ reviewId: "another-review" });
    app.run(`state.pending.clear(); setDraft("overview:new", "Keep this"); setDraftImages("overview:new", ["keep-image"])`);
    finishPost(jsonResponse({}));
    await submitted;
    assert.equal(app.run(`getDraft("overview:new")`), "Keep this");
    assert.equal(app.run(`JSON.stringify(getDraftImages("overview:new"))`), '["keep-image"]');
});

test("pinned composer text and original revision survive reload and scope switches", async () => {
    let activeReview = reviewFixture();
    const fetch: MockFetch = async (url) => {
        if (url === "/api/state") return jsonResponse({ review: activeReview, settings: settingsFixture() });
        if (url.startsWith("/api/snapshot/")) return jsonResponse({ revisionId: activeReview.currentRevisionId, files: [] });
        throw new Error(`unexpected request ${url}`);
    };
    const app = await loadApp({ fetch });
    app.run("renderRuler = () => {}");
    await app.run("loadState()");
    const key = "line:file.ts:new:2-2";
    app.run(`composerHtml(${JSON.stringify(key)}, { kind: "line", path: "file.ts", side: "new", startLine: 2, endLine: 2, revisionId: "r1", alwaysOpen: true }); setDraft(${JSON.stringify(key)}, "keep across reload"); pinComposers()`);
    const pinnedKey = `pinned:r1:${key}`;
    assert.ok(app.localStorage.getItem("sr:r:draft:" + pinnedKey));
    assert.ok(app.localStorage.getItem("sr:r:pinned-composers"));

    activeReview = reviewFixture({ reviewId: "pending-review", currentRevisionId: "p1", scope: "pending" });
    await app.run("loadState()");
    assert.equal(app.read("pinnedComposers.size"), 0, "another scope does not display this draft");
    activeReview = reviewFixture();
    await app.run("loadState()");
    assert.equal(app.read(`pinnedComposers.get(${JSON.stringify(pinnedKey)}).revisionId`), "r1");
    assert.match(app.run(`composerHtml(${JSON.stringify(pinnedKey)}, pinnedComposers.get(${JSON.stringify(pinnedKey)}))`), /keep across reload/);

    const reloaded = await loadApp({ fetch, localStorage: app.localStorage });
    reloaded.run("renderRuler = () => {}");
    await reloaded.run("loadState()");
    assert.equal(reloaded.read(`pinnedComposers.get(${JSON.stringify(pinnedKey)}).revisionId`), "r1");
    assert.match(reloaded.run(`composerHtml(${JSON.stringify(pinnedKey)}, pinnedComposers.get(${JSON.stringify(pinnedKey)}))`), /keep across reload/);
});

test("the sidebar shows review scope near the file tree, and learning controls only when settings are known", async () => {
    const app = await loadApp();
    const top = () => {
        app.run("renderTop()");
        return app.node("#top").innerHTML;
    };
    const footer = () => {
        app.run("renderLoadStatus()");
        return app.node("#review-status-controls").innerHTML;
    };
    const side = () => {
        app.run("renderSide()");
        return app.node("#side").innerHTML;
    };
    const toggle = (html: string) => required(html.match(/<span class="seg"[^>]*>.*?<\/span>/))[0];
    app.state.settings = settingsFixture({ configured: true });

    app.state.review = reviewFixture();
    let html = top();
    assert.doesNotMatch(html, /data-scope=/);
    assert.match(toggle(side()), /data-scope="all" aria-pressed="true"/);
    assert.match(toggle(side()), /data-scope="pending" aria-pressed="false"/);
    assert.match(html, /change-context-heading.*Revision captured 2026.*r1 · 2 files.*<\/div><div class="change-context-details">/s);
    assert.match(html, /<span class="muted">vs<\/span><span class="pill mono" title="merge-base def">main<\/span>/);
    assert.match(html, /↑1 ↓2/);
    assert.match(html, />3 uncommitted</);
    assert.doesNotMatch(toggle(side()), /disabled/);

    app.state.pullRequest = { number: 7, url: "https://github.com/SergeyTeplyakov/Self-Review/pull/7" };
    html = top();
    assert.match(html, /<a class="pill pr-link" href="https:\/\/github\.com\/SergeyTeplyakov\/Self-Review\/pull\/7" target="_blank" rel="noopener noreferrer" title="Open pull request #7 in browser">Open PR #7<\/a>/);
    app.state.pullRequest = null;
    assert.doesNotMatch(top(), /Open PR #7/);

    app.state.review = reviewFixture({ git: { branch: "feature", uncommittedFiles: 0 } });
    html = top();
    assert.match(html, /no upstream/);
    assert.doesNotMatch(html, /\d+ uncommitted/);

    app.state.review = reviewFixture({ scope: "pending", title: "feature (pending changes)", branch: 'x"><img src=1>' });
    html = top();
    assert.doesNotMatch(html, /data-scope=/);
    assert.match(toggle(side()), /data-scope="all" aria-pressed="false"/);
    assert.match(toggle(side()), /data-scope="pending" aria-pressed="true"/);
    assert.match(html, /<span class="muted">uncommitted changes only<\/span>/);
    assert.doesNotMatch(html, />vs<|merge-base|↑|no upstream|\d+ uncommitted|<img/, "pending changes have no base, upstream or uncommitted count to show");

    app.state.switching = true;
    assert.equal(required(toggle(side()).match(/ disabled/g)).length, 2, "both scope buttons are disabled while a switch is in flight");
    app.state.switching = false;

    for (const autoSaveLearnedRules of [false, true]) {
        app.state.settings = settingsFixture({ autoSaveLearnedRules, configured: true });
        assert.match(top(), new RegExp(`<details class="review-settings-menu"><summary[^>]*>Settings</summary>.*<button data-action="configure"[^>]*>Manual review settings`, "s"), String(autoSaveLearnedRules));
        assert.doesNotMatch(app.node("#top").innerHTML, /Delivery:|Auto-save learned rules:/);
        assert.doesNotMatch(footer(), /Auto-save learned rules/, String(autoSaveLearnedRules));
    }
    app.state.settings = null;
    html = top();
    assert.doesNotMatch(html, /Auto-save learned rules:|Manual review settings|data-action="configure"/);
    assert.doesNotMatch(html, /review-settings-menu/);
    assert.match(html, /data-action="refresh"/);
    assert.equal(footer(), "");
});

test("the first-use banner offers manual saving or auto-save, with the old dismissal still supported", async () => {
    const app = await loadApp();
    const banner = (settings: RuntimeState["settings"]) => {
        app.state.settings = settings;
        app.run("renderBanner()");
        return app.node("#banner");
    };
    assert.equal(banner(null).hidden, true);
    assert.equal(banner(settingsFixture({ configured: true })).hidden, true);
    assert.equal(banner(settingsFixture({ dismissed: true })).hidden, true);
    assert.equal(app.node("#banner").innerHTML, "");

    const shown = banner(settingsFixture({ repoName: "<img src=x>" }));
    assert.equal(shown.hidden, false);
    assert.match(shown.innerHTML, /Auto-save learned rules in &lt;img src=x&gt;\?/);
    assert.doesNotMatch(shown.innerHTML, /<img/);
    assert.match(shown.innerHTML, /data-action="learning-set" data-enabled="false" class="primary"[^>]*>Keep manual saving</);
    assert.match(shown.innerHTML, /data-action="learning-set" data-enabled="true"(?! class="primary")[^>]*>Enable auto-save</);
    assert.match(shown.innerHTML, /data-action="learning-dismiss"[^>]*>Not now</);
});

test("the Configure dialog is an accessible modal with auto-save off by default and locks while saving", async () => {
    const app = await loadApp();
    assert.equal(app.run("dialogHtml()"), "", "closed by default");
    app.state.settings = settingsFixture({ repoName: "Org/Repo <x>", configured: true });
    app.state.dialog = {
        autoSaveLearnedRules: false, delivery: "batch",
        instructionMappings: [{ pathPrefix: "src/Area", instructionRoot: "src/Area", splitLanguageSpecific: true }],
        saving: false, error: "",
    };
    const html = app.run("dialogHtml()");
    assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-desc"/);
    assert.match(html, /<h2 id="dialog-title">Review settings<\/h2>/);
    assert.match(html, /<p id="dialog-desc" class="muted">Settings for Org\/Repo &lt;x&gt;\. /);
    assert.match(html, /<legend>Guidelines<\/legend><label><input type="checkbox" name="autoSaveLearnedRules"> Auto-save learned rules<\/label>/);
    assert.match(html, /When off, review and save proposed guidelines yourself\./);
    assert.match(html, /Repository instruction destinations/);
    assert.match(html, /name="mapping-prefix" data-index="0" value="src\/Area"/);
    assert.match(html, /name="mapping-split" data-index="0" checked/);
    assert.deepEqual(
        [...html.matchAll(/<input type="radio" name="delivery" value="(\w+)"( checked)?>/g)].map((m) => [m[1], Boolean(m[2])]),
        [["immediate", false], ["batch", true], ["ask", false]],
    );
    assert.match(html, /<span class="choice-title">Ask for each review<\/span>/);
    assert.doesNotMatch(html, /role="alert"|<button\b[^>]* disabled/);
    assert.match(html, /data-action="dialog-save">Save<\/button>/);

    app.state.dialog = { autoSaveLearnedRules: true, instructionMappings: [], saving: true, error: "Could not save <b>" };
    const busy = app.run("dialogHtml()");
    assert.match(busy, /<div class="modal-error" role="alert">Could not save &lt;b&gt;<\/div>/);
    assert.match(busy, /data-action="dialog-cancel" disabled>/);
    assert.match(busy, /data-action="dialog-save" disabled>Saving…<\/button>/);
    assert.match(busy, /name="autoSaveLearnedRules" checked/);

    app.state.settings = settingsFixture({ repoName: undefined });
    assert.match(app.run("dialogHtml()"), /Settings for this repository\./);
});

test("repository guideline proposals show an editable mapping and destination preview", async () => {
    const app = await loadApp();
    app.state.settings = settingsFixture({
        instructionMappings: [{ pathPrefix: "src/Area", instructionRoot: "src/Area", splitLanguageSpecific: true }],
    });
    app.state.review = reviewFixture({
        lessons: [{
            lessonId: "lesson/route", threadId: "t1", scope: "repo", rule: "Use typed guards.",
            status: "proposed", reviewedPath: "src/Area/Rules.cs",
            destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" }, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    const html = app.run("messageHtml({ messageId: 'm', author: 'agent', body: 'Done', createdAt: '2026-01-02T00:00:00Z', lessonIds: ['lesson/route'] })");
    assert.match(html, /Reviewed file: <code>src\/Area\/Rules\.cs<\/code>/);
    assert.match(html, /name="pathPrefix" value="src\/Area"/);
    assert.match(html, /name="instructionRoot" value="src\/Area"/);
    assert.match(html, /name="destinationKind"><option value="language" selected>/);
    assert.match(html, /Actual destination: <code data-destination-preview>Resolving actual destination…<\/code>/);
    assert.match(html, /Confirm destination and save guideline/);
});

test("legacy repository proposals infer language from their recovered reviewed path", async () => {
    const app = await loadApp();
    app.state.settings = settingsFixture();
    app.state.review = reviewFixture({
        threads: [{
            threadId: "t1", kind: "line",
            location: { path: "src/Area/Rules.cs" }, anchor: null, status: "active", messages: [],
        }],
        lessons: [{
            lessonId: "lesson/legacy", threadId: "t1", scope: "repo", rule: "Use typed guards.",
            status: "proposed", savedTo: null, createdAt: "2026-01-01T00:00:00Z",
        }],
    });

    const html = app.run(`messageHtml(${JSON.stringify({
        messageId: "m", author: "agent", body: "Learned rule", createdAt: "2026-01-02T00:00:00Z", lessonIds: ["lesson/legacy"],
    })})`);
    assert.match(html, /Reviewed file: <code>src\/Area\/Rules\.cs<\/code>/);
    assert.match(html, /name="destinationKind"><option value="language" selected>/);
    assert.match(html, /name="applyTo" value="\*\*\/\*\.cs"/);
});

test("legacy Go proposals infer a language-specific destination", async () => {
    const app = await loadApp();
    app.state.settings = settingsFixture();
    app.state.review = reviewFixture({
        threads: [{
            threadId: "t-go", kind: "line",
            location: { path: "src/Area/check.go" }, anchor: null, status: "active", messages: [],
        }],
        lessons: [{
            lessonId: "lesson/go", threadId: "t-go", scope: "repo", rule: "Keep errors explicit.",
            status: "proposed", savedTo: null, createdAt: "2026-01-01T00:00:00Z",
        }],
    });

    const html = app.run(`messageHtml(${JSON.stringify({
        messageId: "m", author: "agent", body: "Learned rule", createdAt: "2026-01-02T00:00:00Z", lessonIds: ["lesson/go"],
    })})`);
    assert.match(html, /name="destinationKind"><option value="language" selected>/);
    assert.match(html, /name="language" value="go"/);
    assert.match(html, /name="applyTo" value="\*\*\/\*\.go"/);
});

test("overview proposals retain the configured repository-root mapping", async () => {
    const app = await loadApp();
    app.state.settings = settingsFixture({
        instructionMappings: [{ pathPrefix: "", instructionRoot: "src/Area", splitLanguageSpecific: false }],
    });
    app.state.review = reviewFixture({
        threads: [{ threadId: "overview", kind: "overview", location: null, anchor: null, status: "active", messages: [] }],
        lessons: [{
            lessonId: "lesson/overview", threadId: "overview", scope: "repo", rule: "Keep pull requests focused.",
            status: "proposed", savedTo: null, createdAt: "2026-01-01T00:00:00Z",
        }],
    });

    const html = app.run(`messageHtml(${JSON.stringify({
        messageId: "m", author: "agent", body: "Learned rule", createdAt: "2026-01-02T00:00:00Z", lessonIds: ["lesson/overview"],
    })})`);
    assert.match(html, /name="pathPrefix" value=""/);
    assert.match(html, /name="instructionRoot" value="src\/Area"/);
    assert.doesNotMatch(html, /name="splitLanguageSpecific" checked/);
});

test("destination mapping selection follows the provider's path case policy", async () => {
    const app = await loadApp();
    const root = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true };
    const specific = { pathPrefix: "src/Foo", instructionRoot: "docs/Foo", splitLanguageSpecific: false };
    app.state.settings = settingsFixture({ instructionMappings: [root, specific], pathCaseSensitive: true });
    assert.equal(app.read<{ pathPrefix: string } | undefined>('mappingForPath("src/foo/Rules.cs")')?.pathPrefix, "");
    assert.equal(app.read<{ pathPrefix: string } | undefined>('mappingForPath("src/Foo/Rules.cs")')?.pathPrefix, "src/Foo");

    app.state.settings = settingsFixture({ instructionMappings: [root, specific], pathCaseSensitive: false });
    assert.equal(app.read<{ pathPrefix: string } | undefined>('mappingForPath("src/foo/Rules.cs")')?.pathPrefix, "src/Foo");
});

test("destination edits and expanded state survive a main-content rerender", async () => {
    const app = await loadApp();
    app.state.settings = settingsFixture();
    app.state.review = reviewFixture({
        lessons: [{
            lessonId: "lesson/draft", threadId: "t1", scope: "repo", rule: "Use typed guards.",
            status: "proposed", reviewedPath: "src/Area/Rules.cs",
            destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" }, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", "src/Area", false], ["instructionRoot", "docs/Area", false],
        ["splitLanguageSpecific", "", false], ["destinationKind", "language", false],
        ["language", "go", false], ["applyTo", "**/*.go", false],
    ] as const) {
        const field = new MockElement(name === "destinationKind" ? "SELECT" : "INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const details = Object.assign(new MockElement("DETAILS"), { open: true });
    const signature = JSON.stringify(["Use typed guards.", "repo", "src/Area/Rules.cs"]);
    const form = Object.assign(new MockElement(), {
        dataset: { lessonForm: "lesson/draft", lessonMessage: "m", lessonSignature: signature, destinationEdited: "true" },
        querySelector: (selector: string) => selector === "details.lesson-destination"
            ? details
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });
    const main = Object.assign(new MockElement(), { querySelectorAll: () => [form] });

    app.run<(main: MockElement) => void>("captureDestinationFormDrafts")(main);
    const html = app.run(`messageHtml(${JSON.stringify({
        messageId: "m", author: "agent", body: "Learned rule", createdAt: "2026-01-02T00:00:00Z", lessonIds: ["lesson/draft"],
    })})`);
    assert.match(html, /<details class="lesson-destination" open>/);
    assert.match(html, /name="instructionRoot" value="docs\/Area"/);
    assert.match(html, /name="language" value="go"/);
    assert.match(html, /name="applyTo" value="\*\*\/\*\.go"/);
    assert.doesNotMatch(html, /name="splitLanguageSpecific" checked/);
});

test("browser destination suggestions recognize TypeScript module extensions", async () => {
    const app = await loadApp();
    for (const extension of ["mts", "cts"]) {
        const destination = app.run<{ kind: string; language?: string; applyTo?: string }>(
            `suggestedDestination({ reviewedPath: "src/Rules.${extension}" })`,
        );
        assert.deepEqual(
            { kind: destination.kind, language: destination.language, applyTo: destination.applyTo },
            { kind: "language", language: "typescript", applyTo: `**/*.${extension}` },
        );
    }
});

test("untouched proposal destinations follow Configure mapping updates", async () => {
    const app = await loadApp();
    const oldMapping = { pathPrefix: "src/Area", instructionRoot: "old/Area", splitLanguageSpecific: true };
    const newMapping = { pathPrefix: "src/Area", instructionRoot: "new/Area", splitLanguageSpecific: false };
    app.state.settings = settingsFixture({ instructionMappings: [oldMapping] });
    app.state.review = reviewFixture({
        lessons: [{
            lessonId: "lesson/untouched", threadId: "t1", scope: "repo", rule: "Use typed guards.",
            status: "proposed", reviewedPath: "src/Area/Rules.cs",
            destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" }, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", oldMapping.pathPrefix, false], ["instructionRoot", oldMapping.instructionRoot, false],
        ["splitLanguageSpecific", "", oldMapping.splitLanguageSpecific], ["destinationKind", "language", false],
        ["language", "csharp", false], ["applyTo", "**/*.cs", false],
    ] as const) {
        const field = new MockElement(name === "destinationKind" ? "SELECT" : "INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const details = Object.assign(new MockElement("DETAILS"), { open: true });
    const signature = JSON.stringify(["Use typed guards.", "repo", "src/Area/Rules.cs"]);
    const form = Object.assign(new MockElement(), {
        dataset: { lessonForm: "lesson/untouched", lessonMessage: "m", lessonSignature: signature },
        querySelector: (selector: string) => selector === "details.lesson-destination"
            ? details
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });
    const main = Object.assign(new MockElement(), { querySelectorAll: () => [form] });

    app.state.settings = settingsFixture({ instructionMappings: [newMapping] });
    app.run<(main: MockElement) => void>("captureDestinationFormDrafts")(main);
    const html = app.run(`messageHtml(${JSON.stringify({
        messageId: "m", author: "agent", body: "Learned rule", createdAt: "2026-01-02T00:00:00Z", lessonIds: ["lesson/untouched"],
    })})`);

    assert.match(html, /<details class="lesson-destination" open>/, "expanded state survives the rerender");
    assert.match(html, /name="pathPrefix" value="src\/Area"/);
    assert.match(html, /name="instructionRoot" value="new\/Area"/, "the current mapping replaces the untouched old default");
    assert.doesNotMatch(html, /name="instructionRoot" value="old\/Area"/);
    assert.doesNotMatch(html, /name="splitLanguageSpecific" checked/, "the current split setting replaces the untouched old default");
});

test("duplicate proposal cards keep destination edits separate", async () => {
    const app = await loadApp();
    app.state.settings = settingsFixture({
        instructionMappings: [{ pathPrefix: "src/Area", instructionRoot: "configured/Area", splitLanguageSpecific: true }],
    });
    app.state.review = reviewFixture({
        lessons: [{
            lessonId: "lesson/shared", threadId: "t1", scope: "repo", rule: "Use typed guards.",
            status: "proposed", reviewedPath: "src/Area/Rules.cs",
            destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" }, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    const signature = JSON.stringify(["Use typed guards.", "repo", "src/Area/Rules.cs"]);
    const createForm = (messageId: string, instructionRoot: string, detailsOpen: boolean) => {
        const fields = new Map<string, MockElement>();
        for (const [name, value, checked] of [
            ["pathPrefix", "src/Area", false], ["instructionRoot", instructionRoot, false],
            ["splitLanguageSpecific", "", true], ["destinationKind", "language", false],
            ["language", "csharp", false], ["applyTo", "**/*.cs", false],
        ] as const) {
            const field = new MockElement(name === "destinationKind" ? "SELECT" : "INPUT");
            Object.assign(field, { name, value, checked });
            fields.set(name, field);
        }
        const details = Object.assign(new MockElement("DETAILS"), { open: detailsOpen });
        const form = Object.assign(new MockElement(), {
            dataset: { lessonForm: "lesson/shared", lessonMessage: messageId, lessonSignature: signature },
            querySelector: (selector: string) => selector === "details.lesson-destination"
                ? details
                : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
        });
        const root = fields.get("instructionRoot");
        assert.ok(root);
        root.closest = (selector: string) => selector === "[data-lesson-form]" ? form : null;
        return { form, root };
    };
    const edited = createForm("m1", "edited/Area", true);
    const untouched = createForm("m2", "configured/Area", false);
    const firstMessage = {
        messageId: "m1", author: "agent", body: "Original proposal.", createdAt: "2026-01-02T00:00:00Z",
        lessonIds: ["lesson/shared"],
    };
    const secondMessage = {
        messageId: "m2", author: "agent", body: "Refined proposal.", createdAt: "2026-01-03T00:00:00Z",
        lessonIds: ["lesson/shared"],
    };
    assert.match(app.run(`messageHtml(${JSON.stringify(firstMessage)})`), /data-lesson-message="m1"/);
    assert.match(app.run(`messageHtml(${JSON.stringify(secondMessage)})`), /data-lesson-message="m2"/);

    app.run("onInput")({ target: edited.root });
    const main = Object.assign(new MockElement(), { querySelectorAll: () => [edited.form, untouched.form] });
    app.run<(main: MockElement) => void>("captureDestinationFormDrafts")(main);

    const firstHtml = app.run(`messageHtml(${JSON.stringify(firstMessage)})`);
    const secondHtml = app.run(`messageHtml(${JSON.stringify(secondMessage)})`);
    assert.match(firstHtml, /name="instructionRoot" value="edited\/Area"/);
    assert.match(firstHtml, /<details class="lesson-destination" open>/);
    assert.match(firstHtml, /data-destination-edited="true"/);
    assert.match(secondHtml, /name="instructionRoot" value="configured\/Area"/);
    assert.doesNotMatch(secondHtml, /data-destination-edited="true"/);
});

test("repository destination preview displays the provider-resolved file", async () => {
    const calls: CapturedPost[] = [];
    const app = await loadApp({ fetch: async (url, init) => {
        calls.push([init?.method ?? "GET", url, requestBody(init)]);
        return jsonResponse({ savedTo: "src/Area/.github/instructions/csharp-documentation.instructions.md", needsConfirmation: false });
    } });
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", "src/Area", false], ["instructionRoot", "src/Area", false],
        ["splitLanguageSpecific", "", false], ["destinationKind", "language", false],
        ["language", "csharp", false], ["applyTo", "**/*.cs", false],
    ] as const) {
        const field = new MockElement("INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const preview = new MockElement();
    const form = Object.assign(new MockElement(), {
        dataset: { lessonForm: "lesson/route" },
        querySelector: (selector: string) => selector === "[data-destination-preview]"
            ? preview
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });

    const resolve = app.run<(form: MockElement) => Promise<{ savedTo: string; needsConfirmation: boolean } | null>>("updateDestinationPreview");
    const result = await resolve(form);
    assert.equal(result?.savedTo, "src/Area/.github/instructions/csharp-documentation.instructions.md");
    assert.equal(result?.needsConfirmation, false);
    assert.equal(preview.textContent, "src/Area/.github/instructions/csharp-documentation.instructions.md");
    assert.deepEqual(calls, [["POST", "/api/lessons/lesson%2Froute/destination", {
        mapping: { pathPrefix: "src/Area", instructionRoot: "src/Area", splitLanguageSpecific: false },
        destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" },
    }]]);
});

test("an older A preview cannot overwrite the latest result after A-to-B-to-A edits", async () => {
    const responses: Array<(value: unknown) => void> = [];
    const app = await loadApp({ fetch: () => new Promise((resolve) => responses.push(resolve)) });
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", "", false], ["instructionRoot", "", false],
        ["splitLanguageSpecific", "", true], ["destinationKind", "language", false],
        ["language", "csharp", false], ["applyTo", "**/*.cs", false],
    ] as const) {
        const field = new MockElement("INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const preview = new MockElement();
    const form = Object.assign(new MockElement(), {
        dataset: { lessonForm: "lesson/race" },
        querySelector: (selector: string) => selector === "[data-destination-preview]"
            ? preview
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });
    const resolve = app.run<(form: MockElement) => Promise<{ savedTo: string; needsConfirmation: boolean } | null>>("updateDestinationPreview");

    const first = resolve(form);
    fields.get("applyTo")!.value = "**/*.ts";
    const second = resolve(form);
    fields.get("applyTo")!.value = "**/*.cs";
    const latest = resolve(form);
    responses[2](jsonResponse({ savedTo: "latest-A.md", needsConfirmation: false }));
    await latest;
    responses[0](jsonResponse({ savedTo: "stale-A.md", needsConfirmation: false }));
    await first;
    responses[1](jsonResponse({ savedTo: "B.md", needsConfirmation: false }));
    await second;

    assert.equal(preview.textContent, "latest-A.md");
});

test("a failed destination preview can be retried on the same form", async () => {
    let attempts = 0;
    const app = await loadApp({ fetch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("offline");
        return jsonResponse({ savedTo: ".github/instructions/csharp.instructions.md", needsConfirmation: true });
    } });
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", "", false], ["instructionRoot", "", false],
        ["splitLanguageSpecific", "", true], ["destinationKind", "language", false],
        ["language", "csharp", false], ["applyTo", "**/*.cs", false],
    ] as const) {
        const field = new MockElement("INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const preview = new MockElement();
    const form = Object.assign(new MockElement(), {
        dataset: { lessonForm: "lesson/retry" },
        querySelector: (selector: string) => selector === "[data-destination-preview]"
            ? preview
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });
    const resolve = app.run<(form: MockElement) => Promise<{ savedTo: string; needsConfirmation: boolean } | null>>("updateDestinationPreview");

    assert.equal(await resolve(form), null);
    const retried = await resolve(form);
    assert.equal(retried?.savedTo, ".github/instructions/csharp.instructions.md");
    assert.equal(retried?.needsConfirmation, true);
    assert.equal(attempts, 2);
    assert.equal(preview.textContent, ".github/instructions/csharp.instructions.md (new file; confirmation required)");
});

test("saving during destination resolution only refreshes the preview", async () => {
    let resolveFetch!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => { resolveFetch = resolve; });
    const calls: CapturedPost[] = [];
    const app = await loadApp({ fetch: async (url, init) => {
        calls.push([init?.method ?? "GET", url, requestBody(init)]);
        return response;
    } });
    app.state.review = reviewFixture({
        lessons: [{
            lessonId: "lesson/pending", threadId: "t1", scope: "repo", rule: "Use typed guards.",
            status: "proposed", savedTo: null, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", "", false], ["instructionRoot", "", false],
        ["splitLanguageSpecific", "", true], ["destinationKind", "language", false],
        ["language", "csharp", false], ["applyTo", "**/*.cs", false],
    ] as const) {
        const field = new MockElement("INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const preview = new MockElement();
    const form = Object.assign(new MockElement(), {
        dataset: { lessonForm: "lesson/pending" },
        querySelector: (selector: string) => selector === "[data-destination-preview]"
            ? preview
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });
    const button = new MockElement("BUTTON");
    button.dataset = { action: "save-lesson", lesson: "lesson/pending" };
    button.closest = (selector: string) => selector === "[data-lesson-form]" ? form : button;

    const saving = app.run("onClick")({ target: button });
    resolveFetch(jsonResponse({ savedTo: ".github/instructions/csharp.instructions.md", needsConfirmation: true }));
    await saving;

    assert.equal(calls.length, 1, "the only request is the destination preview");
    assert.equal(calls[0][1], "/api/lessons/lesson%2Fpending/destination");
    assert.equal(preview.textContent, ".github/instructions/csharp.instructions.md (new file; confirmation required)");
});

test("saving unrelated Configure settings omits an unchanged mapping snapshot", async () => {
    const original = [{ pathPrefix: "src/Area", instructionRoot: "src/Area", splitLanguageSpecific: true }];
    const concurrent = { pathPrefix: "src/Other", instructionRoot: "src/Other", splitLanguageSpecific: false };
    const calls: CapturedPost[] = [];
    const app = await loadApp({ fetch: async (url, init) => {
        calls.push([init?.method ?? "GET", url, requestBody(init)]);
        return jsonResponse(settingsFixture({
            delivery: "batch", instructionMappings: [...original, concurrent], pathCaseSensitive: true,
        }));
    } });
    app.state.settings = settingsFixture({ instructionMappings: original, pathCaseSensitive: true });
    app.run("openConfigure()");
    if (!app.state.dialog) throw new Error("Configure dialog did not open.");
    app.state.dialog.delivery = "batch";

    await app.run<Promise<void>>("saveConfigure()");

    assert.deepEqual(calls, [["POST", "/api/settings", { autoSaveLearnedRules: false, delivery: "batch" }]]);
    assert.deepEqual(app.read("state.settings.instructionMappings"), [...original, concurrent]);
});

test("Configure saves instruction mappings and comment concurrency together", async () => {
    const original = [{ pathPrefix: "src/Area", instructionRoot: "src/Area", splitLanguageSpecific: true }];
    const edited = [{ ...original[0], instructionRoot: "" }];
    const calls: CapturedPost[] = [];
    const app = await loadApp({ fetch: async (url, init) => {
        calls.push([init?.method ?? "GET", url, requestBody(init)]);
        return jsonResponse(settingsFixture({ instructionMappings: edited, commentConcurrency: 4 }));
    } });
    app.state.settings = settingsFixture({ instructionMappings: original, commentConcurrency: 2 });
    app.run("openConfigure()");
    if (!app.state.dialog) throw new Error("Configure dialog did not open.");
    assert.equal(app.state.dialog.commentConcurrency, 2);
    app.state.dialog.instructionMappings = edited;
    app.state.dialog.commentConcurrency = 4;

    await app.run<Promise<void>>("saveConfigure()");

    assert.deepEqual(calls, [["POST", "/api/settings", {
        autoSaveLearnedRules: false, delivery: "immediate", commentConcurrency: 4,
        instructionMappings: edited, expectedInstructionMappings: original,
    }]]);
    assert.deepEqual(app.read("state.settings.instructionMappings"), edited);
    assert.equal(app.read("state.settings.commentConcurrency"), 4);
});

test("repository save submits the rendered rule even if the review reloads during preview", async () => {
    let resolvePreview!: (value: unknown) => void;
    const previewResponse = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    const calls: CapturedPost[] = [];
    const nextReview = reviewFixture({
        lessons: [{
            lessonId: "lesson/clicked", threadId: "t1", scope: "repo", rule: "Revised rule.",
            status: "proposed", reviewedPath: "src/Rules.cs",
            destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" }, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    const app = await loadApp({ fetch: async (url, init) => {
        calls.push([init?.method ?? "GET", url, requestBody(init)]);
        if (url.endsWith("/destination")) return previewResponse;
        if (url.endsWith("/save")) return jsonResponse({ status: "saved" });
        if (url === "/api/state") return jsonResponse({ review: nextReview, settings: settingsFixture() });
        if (url === "/api/snapshot/r1") return jsonResponse({ revisionId: "r1", files: [] });
        throw new Error(`Unexpected request: ${url}`);
    } });
    const originalReview = reviewFixture({
        lessons: [{
            lessonId: "lesson/clicked", threadId: "t1", scope: "repo", rule: "Original rule.",
            status: "proposed", reviewedPath: "src/Rules.cs",
            destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" }, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    app.state.review = originalReview;
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", "", false], ["instructionRoot", "", false],
        ["splitLanguageSpecific", "", true], ["destinationKind", "language", false],
        ["language", "csharp", false], ["applyTo", "**/*.cs", false],
    ] as const) {
        const field = new MockElement("INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const preview = new MockElement();
    const proposal = {
        mapping: { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true },
        destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" },
    };
    const form = Object.assign(new MockElement(), {
        dataset: {
            lessonForm: "lesson/clicked", rule: "Original rule.", scope: "repo",
            destinationPreviewState: "ready", destinationPreviewKey: JSON.stringify(proposal),
        },
        querySelector: (selector: string) => selector === "[data-destination-preview]"
            ? preview
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });
    const button = Object.assign(new MockElement("BUTTON"), {
        dataset: { action: "save-lesson", lesson: "lesson/clicked" },
    });
    button.closest = (selector: string) => selector === "[data-lesson-form]" ? form : button;

    const saving = app.run("onClick")({ target: button });
    (originalReview.lessons as Array<{ rule: string }>)[0].rule = "Revised rule.";
    resolvePreview(jsonResponse({ savedTo: ".github/instructions/csharp.instructions.md", needsConfirmation: false }));
    await saving;

    const saved = calls.find(([, url]) => typeof url === "string" && url.endsWith("/save"));
    assert.ok(saved);
    assert.equal((saved[2] as { rule: string }).rule, "Original rule.");
    assert.equal((saved[2] as { scope: string }).scope, "repo");
});

test("a failed repository save refreshes the destination before allowing another attempt", async () => {
    const oldDestination = ".github/instructions/csharp.instructions.md";
    const newDestination = "src/Rules/.github/instructions/csharp.instructions.md";
    let previews = 0;
    const requestOrder: string[] = [];
    const saves: Record<string, unknown>[] = [];
    const review = reviewFixture({
        lessons: [{
            lessonId: "lesson/clicked", threadId: "t1", scope: "repo", rule: "Keep pull requests focused.",
            status: "proposed", reviewedPath: "src/Rules/Analyzer.cs",
            destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" }, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    const app = await loadApp({ fetch: async (url, init) => {
        if (url.endsWith("/destination")) {
            previews++;
            requestOrder.push("destination");
            return jsonResponse({
                savedTo: previews === 1 ? oldDestination : newDestination,
                needsConfirmation: false,
            });
        }
        if (url.endsWith("/save")) {
            requestOrder.push("save");
            saves.push(requestBody(init));
            if (saves.length === 1) {
                return jsonResponse({
                    error: {
                        message: `The instruction destination changed to ${newDestination}. Review and confirm the updated destination.`,
                    },
                }, 409);
            }
            return jsonResponse({ status: "saved" });
        }
        if (url === "/api/state") return jsonResponse({ review, settings: settingsFixture() });
        if (url === "/api/snapshot/r1") return jsonResponse({ revisionId: "r1", files: [] });
        throw new Error(`Unexpected request: ${url}`);
    } });
    app.state.review = review;
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", "src/Rules", false], ["instructionRoot", "src/Rules", false],
        ["splitLanguageSpecific", "", true], ["destinationKind", "language", false],
        ["language", "csharp", false], ["applyTo", "**/*.cs", false],
    ] as const) {
        const field = new MockElement("INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const preview = new MockElement();
    const proposal = {
        mapping: { pathPrefix: "src/Rules", instructionRoot: "src/Rules", splitLanguageSpecific: true },
        destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" },
    };
    const form = Object.assign(new MockElement(), {
        dataset: {
            lessonForm: "lesson/clicked", rule: "Keep pull requests focused.", scope: "repo",
            destinationPreviewState: "ready", destinationPreviewKey: JSON.stringify(proposal),
        },
        querySelector: (selector: string) => selector === "[data-destination-preview]"
            ? preview
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });
    const button = Object.assign(new MockElement("BUTTON"), {
        dataset: { action: "save-lesson", lesson: "lesson/clicked" },
    });
    button.closest = (selector: string) => selector === "[data-lesson-form]" ? form : button;

    await app.run("onClick")({ target: button });

    assert.equal(previews, 2, "the failed save triggers a fresh destination request");
    assert.equal(saves.length, 1, "the refreshed destination still requires another confirmation");
    assert.equal(preview.textContent, newDestination);
    assert.equal(saves[0].expectedSavedTo, oldDestination);
    assert.equal(form.dataset.destinationPreviewKey, JSON.stringify(proposal));

    await app.run("onClick")({ target: button });

    assert.deepEqual(requestOrder.slice(0, 4), ["destination", "save", "destination", "save"]);
    assert.equal(saves.length, 2);
    assert.equal(saves[1].expectedSavedTo, newDestination);
    assert.equal(saves[1].rule, "Keep pull requests focused.");
    assert.equal(saves[1].scope, "repo");
});

test("a save conflict discards a destination edit made against mappings that changed since", async () => {
    const oldMapping = { pathPrefix: "src/Area", instructionRoot: "old/Area", splitLanguageSpecific: true };
    const newMapping = { pathPrefix: "src/Area", instructionRoot: "new/Area", splitLanguageSpecific: true };
    const saves: Record<string, unknown>[] = [];
    const review = reviewFixture({
        lessons: [{
            lessonId: "lesson/stale", threadId: "t1", scope: "repo", rule: "Use typed guards.",
            status: "proposed", reviewedPath: "src/Area/Rules.cs",
            destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" }, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    const app = await loadApp({ fetch: async (url, init) => {
        if (url.endsWith("/destination")) return jsonResponse({ savedTo: "edited/Area/.github/instructions/csharp.instructions.md", needsConfirmation: false });
        if (url.endsWith("/save")) {
            saves.push(requestBody(init));
            return jsonResponse({ error: { message: "Repository instruction mappings changed after this guideline was shown." } }, 409);
        }
        if (url === "/api/state") return jsonResponse({ review, settings: settingsFixture({ instructionMappings: [newMapping] }) });
        if (url === "/api/snapshot/r1") return jsonResponse({ revisionId: "r1", files: [] });
        throw new Error(`Unexpected request: ${url}`);
    } });
    app.state.settings = settingsFixture({ instructionMappings: [oldMapping] });
    app.state.review = review;
    app.run("renderRuler = () => {}");
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", "src/Area", false], ["instructionRoot", "edited/Area", false],
        ["splitLanguageSpecific", "", true], ["destinationKind", "language", false],
        ["language", "csharp", false], ["applyTo", "**/*.cs", false],
    ] as const) {
        const field = new MockElement(name === "destinationKind" ? "SELECT" : "INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const details = Object.assign(new MockElement("DETAILS"), { open: true });
    const preview = new MockElement();
    const proposal = {
        mapping: { pathPrefix: "src/Area", instructionRoot: "edited/Area", splitLanguageSpecific: true },
        destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" },
    };
    const signature = JSON.stringify(["Use typed guards.", "repo", "src/Area/Rules.cs"]);
    const form = Object.assign(new MockElement(), {
        dataset: {
            lessonForm: "lesson/stale", lessonMessage: "m", lessonSignature: signature, destinationEdited: "true" as string | undefined,
            expectedMappings: JSON.stringify([oldMapping]), rule: "Use typed guards.", scope: "repo",
            destinationPreviewState: "ready", destinationPreviewKey: JSON.stringify(proposal),
        },
        querySelector: (selector: string) => selector === "details.lesson-destination"
            ? details
            : selector === "[data-destination-preview]" ? preview
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });
    app.run<(main: MockElement) => void>("captureDestinationFormDrafts")(Object.assign(new MockElement(), { querySelectorAll: () => [form] }));
    app.document.querySelectorAll = (selector: string) => selector === "#main [data-lesson-form]" ? [form] : [];
    const button = Object.assign(new MockElement("BUTTON"), { dataset: { action: "save-lesson", lesson: "lesson/stale" } });
    button.closest = (selector: string) => selector === "[data-lesson-form]" ? form : button;

    await app.run("onClick")({ target: button });

    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].expectedInstructionMappings, [oldMapping], "the save carries the mappings the card was edited against");
    assert.deepEqual(saves[0].mapping, proposal.mapping);
    assert.equal(form.dataset.destinationEdited, undefined);
    const html = app.run(`messageHtml(${JSON.stringify({
        messageId: "m", author: "agent", body: "Learned rule", createdAt: "2026-01-02T00:00:00Z", lessonIds: ["lesson/stale"],
    })})`);
    assert.match(html, /name="instructionRoot" value="new\/Area"/, "the card shows the current stored mapping");
    assert.doesNotMatch(html, /data-destination-edited="true"/);
    assert.ok(html.includes(`data-expected-mappings="${JSON.stringify([newMapping]).replace(/"/g, "&quot;")}"`), "the next save is checked against the current mappings");
});

test("a save conflict on an untouched card shows the current stored mapping before the next attempt", async () => {
    const oldMapping = { pathPrefix: "src/Area", instructionRoot: "old/Area", splitLanguageSpecific: true };
    const newMapping = { pathPrefix: "src/Area", instructionRoot: "new/Area", splitLanguageSpecific: true };
    const saves: Record<string, unknown>[] = [];
    const review = reviewFixture({
        lessons: [{
            lessonId: "lesson/untouched", threadId: "t1", scope: "repo", rule: "Use typed guards.",
            status: "proposed", reviewedPath: "src/Area/Rules.cs",
            destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" }, createdAt: "2026-01-01T00:00:00Z",
        }],
    });
    const app = await loadApp({ fetch: async (url, init) => {
        if (url.endsWith("/destination")) return jsonResponse({ savedTo: "old/Area/.github/instructions/csharp.instructions.md", needsConfirmation: false });
        if (url.endsWith("/save")) {
            saves.push(requestBody(init));
            return jsonResponse({ error: { message: "Repository instruction mappings changed after this guideline was shown." } }, 409);
        }
        if (url === "/api/state") return jsonResponse({ review, settings: settingsFixture({ instructionMappings: [newMapping] }) });
        if (url === "/api/snapshot/r1") return jsonResponse({ revisionId: "r1", files: [] });
        throw new Error(`Unexpected request: ${url}`);
    } });
    app.state.settings = settingsFixture({ instructionMappings: [oldMapping] });
    app.state.review = review;
    app.run("renderRuler = () => {}");
    const fields = new Map<string, MockElement>();
    for (const [name, value, checked] of [
        ["pathPrefix", "src/Area", false], ["instructionRoot", "old/Area", false],
        ["splitLanguageSpecific", "", true], ["destinationKind", "language", false],
        ["language", "csharp", false], ["applyTo", "**/*.cs", false],
    ] as const) {
        const field = new MockElement(name === "destinationKind" ? "SELECT" : "INPUT");
        Object.assign(field, { name, value, checked });
        fields.set(name, field);
    }
    const details = Object.assign(new MockElement("DETAILS"), { open: true });
    const preview = new MockElement();
    const proposal = {
        mapping: oldMapping,
        destination: { kind: "language", language: "csharp", applyTo: "**/*.cs" },
    };
    const form = Object.assign(new MockElement(), {
        dataset: {
            lessonForm: "lesson/untouched", lessonMessage: "m",
            lessonSignature: JSON.stringify(["Use typed guards.", "repo", "src/Area/Rules.cs"]),
            expectedMappings: JSON.stringify([oldMapping]), rule: "Use typed guards.", scope: "repo",
            destinationPreviewState: "ready", destinationPreviewKey: JSON.stringify(proposal),
        },
        querySelector: (selector: string) => selector === "details.lesson-destination"
            ? details
            : selector === "[data-destination-preview]" ? preview
            : fields.get(selector.match(/name="([^"]+)"/)?.[1] ?? "") ?? null,
    });
    app.run<(main: MockElement) => void>("captureDestinationFormDrafts")(Object.assign(new MockElement(), { querySelectorAll: () => [form] }));
    app.document.querySelectorAll = (selector: string) => selector === "#main [data-lesson-form]" ? [form] : [];
    const button = Object.assign(new MockElement("BUTTON"), { dataset: { action: "save-lesson", lesson: "lesson/untouched" } });
    button.closest = (selector: string) => selector === "[data-lesson-form]" ? form : button;

    await app.run("onClick")({ target: button });

    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].expectedInstructionMappings, [oldMapping]);
    const html = app.run(`messageHtml(${JSON.stringify({
        messageId: "m", author: "agent", body: "Learned rule", createdAt: "2026-01-02T00:00:00Z", lessonIds: ["lesson/untouched"],
    })})`);
    assert.match(html, /name="instructionRoot" value="new\/Area"/, "the card shows the current stored mapping");
    assert.ok(html.includes(`data-expected-mappings="${JSON.stringify([newMapping]).replace(/"/g, "&quot;")}"`), "the next save is checked against the current mappings");
});

test("the Configure dialog opens on the saved mode, keeps the page inert behind it, traps Tab, and closes on Escape", async () => {
    const app = await loadApp();
    let prevented = 0;
    const press = (event: { key?: string; shiftKey?: boolean }) => app.run("onKeyDown")({ preventDefault: () => prevented++, ...event });
    app.state.review = reviewFixture();

    app.state.settings = null;
    app.run("openConfigure()");
    assert.equal(app.state.dialog, null, "there is nothing to configure until the server reports the settings");
    app.state.settings = settingsFixture({ configured: true });
    app.run("openConfigure()");
    assert.equal(dialog(app).autoSaveLearnedRules, false, "auto-save defaults to off");
    assert.doesNotMatch(app.node("#dialog").innerHTML, /name="autoSaveLearnedRules" checked/);
    await clicker(app)("dialog-cancel");

    app.state.settings = settingsFixture({ autoSaveLearnedRules: true, configured: true });

    app.run("openConfigure()");
    assert.equal(dialog(app).autoSaveLearnedRules, true);
    assert.match(app.node("#dialog").innerHTML, /name="autoSaveLearnedRules" checked/);
    for (const id of ["#top", "#banner", "#layout", "#review-status-slot"]) assert.equal(app.node(id).inert, true, id);
    assert.equal(app.focused.at(-1), '#dialog input[name="autoSaveLearnedRules"]');
    const opened = app.state.dialog;
    app.run("openConfigure()");
    assert.equal(app.state.dialog, opened, "opening twice keeps the first dialog");

    await app.run("onChange")({ target: Object.assign(new MockElement("INPUT"), { name: "autoSaveLearnedRules", checked: false }) });
    assert.equal(dialog(app).autoSaveLearnedRules, false);
    assert.equal(app.state.settings.autoSaveLearnedRules, true, "the choice is only a draft until Save");

    const focus: string[] = [];
    const deliveryRadios: MockFocusable[] = [
        Object.assign(new MockElement("INPUT"), { checked: false, name: "delivery" }),
        Object.assign(new MockElement("INPUT"), { checked: true, name: "delivery", focus: () => focus.push("radio") }),
        Object.assign(new MockElement("INPUT"), { checked: false, name: "delivery" }),
    ];
    const autoSaveCheckbox = Object.assign(new MockElement("INPUT"), { checked: true, name: "autoSaveLearnedRules", focus: () => focus.push("checkbox") });
    const buttons: MockFocusable[] = [
        Object.assign(new MockElement("BUTTON"), { focus: () => focus.push("cancel") }),
        Object.assign(new MockElement("BUTTON"), { focus: () => focus.push("save") }),
    ];
    const querySelector = app.document.querySelector;
    app.document.querySelector = (selector: string) => (selector.includes("autoSaveLearnedRules") ? autoSaveCheckbox : querySelector(selector));
    app.document.querySelectorAll = (selector: string) => selector === '#dialog input[name="delivery"]'
        ? deliveryRadios
        : selector.includes("#dialog input:not([disabled])") ? [autoSaveCheckbox, ...deliveryRadios.slice(0, 1), ...buttons] : buttons;
    app.document.activeElement = buttons[1];
    press({ key: "Tab", shiftKey: false });
    app.document.activeElement = autoSaveCheckbox;
    press({ key: "Tab", shiftKey: true });
    app.document.activeElement = buttons[0];
    press({ key: "Tab", shiftKey: false });
    assert.deepEqual(focus, ["checkbox", "save"], "Tab wraps from the last stop to the checkbox, and Shift+Tab from the checkbox to the last");
    assert.equal(prevented, 2, "Tab between the stops is left to the browser");

    press({ key: "Escape" });
    assert.equal(app.state.dialog, null);
    assert.equal(prevented, 3);
    assert.equal(app.node("#dialog").innerHTML, "");
    for (const id of ["#top", "#banner", "#layout", "#review-status-slot"]) assert.equal(app.node(id).inert, false, id);
    assert.equal(app.focused.at(-1), '[data-action="configure"]', "focus returns to the button that opened the dialog");

    app.run("openConfigure()");
    dialog(app).saving = true;
    press({ key: "Escape" });
    assert.notEqual(app.state.dialog, null, "a save in flight cannot be dismissed");
});

test("the banner, Configure checkbox, and dismissal persist auto-save settings and report failures", async () => {
    const posts: CapturedPost[] = [];
    let settings: ReturnType<typeof settingsFixture> | undefined = settingsFixture();
    let failure: string | null = null;
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        const body = requestBody(init);
        posts.push([init?.method ?? "", url, body]);
        if (failure) return jsonResponse({ error: { message: failure } }, 500);
        settings = {
            ...(settings ?? settingsFixture()),
            ...(typeof body.autoSaveLearnedRules === "boolean" ? { autoSaveLearnedRules: body.autoSaveLearnedRules, configured: true } : {}),
            ...(typeof body.delivery === "string" ? { delivery: body.delivery } : {}),
            ...(body.dismissed === true ? { dismissed: true } : {}),
        };
        return jsonResponse(settings);
    };
    const app = await loadApp({ fetch });
    const click = clicker(app);
    app.state.review = reviewFixture();
    app.state.settings = settings;
    app.run("renderBanner()");
    assert.equal(app.node("#banner").hidden, false);

    await click("learning-set", { enabled: "false" });
    assert.deepEqual(posts.at(-1), ["POST", "/api/settings", { autoSaveLearnedRules: false }]);
    assert.equal(app.state.settings.autoSaveLearnedRules, false);
    assert.equal(app.node("#banner").hidden, true, "choosing manual saving settles the question");
    assert.equal(app.node("#toast").textContent, "Auto-save learned rules: Off");

    settings = settingsFixture();
    app.state.settings = settings;
    await click("learning-dismiss");
    assert.deepEqual(posts.at(-1), ["POST", "/api/settings", { dismissed: true }]);
    assert.equal(app.node("#banner").hidden, true);
    assert.equal(app.state.settings.configured, false, "Not now leaves the auto-save setting at its default");
    assert.equal(app.state.settings.autoSaveLearnedRules, false);

    await click("configure");
    assert.equal(dialog(app).autoSaveLearnedRules, false);
    assert.equal(dialog(app).delivery, "immediate");
    await app.run("onChange")({ target: Object.assign(new MockElement("INPUT"), { name: "autoSaveLearnedRules", checked: true }) });
    await app.run("onChange")({ target: { name: "delivery", value: "batch" } });
    const settingsMenu = app.node(".review-settings-menu");
    const settingsSummary = app.node(".review-settings-menu > summary");
    app.node('[data-action="configure"]').closest = (selector) => selector === "details:not([open])" ? settingsMenu : null;
    settingsMenu.querySelector = (selector) => selector === "summary" ? settingsSummary : null;
    await click("dialog-save");
    assert.deepEqual(posts.at(-1), ["POST", "/api/settings", { autoSaveLearnedRules: true, delivery: "batch" }]);
    assert.equal(app.state.dialog, null);
    assert.equal(app.state.settings.autoSaveLearnedRules, true);
    assert.equal(app.state.settings.delivery, "batch");
    assert.equal(app.node("#dialog").innerHTML, "");
    assert.equal(app.node("#toast").textContent, "Saved. Auto-save learned rules: On · Delivery: Batch");
    assert.equal(app.focused.at(-1), ".review-settings-menu > summary", "focus returns to the visible Settings summary after the menu collapses");

    await click("configure");
    failure = "disk full";
    await app.run("onChange")({ target: Object.assign(new MockElement("INPUT"), { name: "autoSaveLearnedRules", checked: false }) });
    await click("dialog-save");
    assert.equal(dialog(app).saving, false);
    assert.equal(dialog(app).error, "disk full");
    assert.equal(app.state.settings.autoSaveLearnedRules, true, "a failed save changes nothing");
    assert.match(app.node("#dialog").innerHTML, /role="alert">disk full</);
    assert.equal(app.focused.at(-1), '#dialog [data-action="dialog-save"]');
    failure = null;
    await click("dialog-save");
    assert.equal(app.state.dialog, null, "retrying after the failure succeeds");
    assert.equal(app.state.settings.autoSaveLearnedRules, false);

    failure = "offline";
    await click("learning-set", { enabled: "true" });
    assert.equal(app.state.settings.autoSaveLearnedRules, false);
    assert.equal(app.node("#toast").textContent, "offline");
    assert.equal(app.node("#toast").className, "error");
});

test("the Configure dialog closes from Cancel or a click on the backdrop, but not from a click inside it or while saving", async () => {
    const app = await loadApp();
    const click = clicker(app);
    app.state.review = reviewFixture();
    app.state.settings = settingsFixture({ configured: true });

    await click("configure");
    const backdrop = Object.assign(new MockElement("DIV"), { dataset: { action: "dialog-backdrop" } });
    backdrop.closest = () => backdrop;
    await app.run("onClick")({ target: { closest: () => backdrop } });
    assert.notEqual(app.state.dialog, null, "a click that landed inside the dialog does not close it");
    await app.run("onClick")({ target: backdrop });
    assert.equal(app.state.dialog, null);

    await click("configure");
    dialog(app).saving = true;
    await click("dialog-cancel");
    assert.notEqual(app.state.dialog, null);
    dialog(app).saving = false;
    await click("dialog-cancel");
    assert.equal(app.state.dialog, null);
});

test("lessons show their status next to each rule in the thread and in the Lessons learned table", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture({
        lessons: [
            { lessonId: "l-1", threadId: "t1", scope: "repo", rule: "Prefer `ILogger`", savedTo: "AGENTS.md", createdAt: "2026-01-01T00:00:00Z" },
            { lessonId: "l-2", threadId: "t1", scope: "personal", rule: "Keep <b>short</b>", status: "proposed", saveError: "Automatic save failed: offline", savedTo: null, createdAt: "2026-01-02T00:00:00Z" },
            { lessonId: "l-3", threadId: "t2", scope: "repo", rule: "Avoid globals", status: "declined", savedTo: null, createdAt: "2026-01-03T00:00:00Z" },
            { lessonId: "l-4", threadId: "t2", scope: "repo", rule: "Unknown status", status: "bogus", savedTo: null, createdAt: "2026-01-04T00:00:00Z" },
        ],
    });
    const message = (lessonIds: string[]) => app.run(`messageHtml(${JSON.stringify({ messageId: "m", author: "agent", body: "Done", outcome: "fixed", createdAt: "2026-01-02T00:00:00Z", lessonIds })})`);

    const html = message(["l-1", "l-2", "missing"]);
    assert.match(html, /<li><span class="badge">repo<\/span> <span class="badge lesson-saved"[^>]*>saved<\/span> Prefer <code>ILogger<\/code> <span class="muted mono">→ AGENTS\.md<\/span><\/li>/, "a lesson recorded before statuses existed was saved");
    assert.match(html, /<li><span class="badge">personal<\/span> <span class="badge lesson-proposed"[^>]*>proposed<\/span> Keep &lt;b&gt;short&lt;\/b&gt;/, "a proposed lesson is not saved anywhere yet");
    assert.match(html, /data-action="save-lesson" data-lesson="l-2" data-proposal="[^"]*">Save guideline<\/button> <span role="status">Automatic save failed: offline<\/span>/, "an auto-save failure leaves the proposal and its manual save action visible");
    assert.equal(required(html.match(/<li>/g)).length, 2, "an unknown lesson id is skipped");
    assert.doesNotMatch(message([]), /Guidelines:/);

    const table = app.run("lessonsView()");
    assert.match(table, /<h2>Lessons learned \(4\)<\/h2>/);
    assert.match(table, /<th>Scope<\/th><th>Status<\/th><th>Rule<\/th><th>Saved to<\/th>/);
    assert.deepEqual([...table.matchAll(/badge lesson-(\w+)"/g)].map((m) => m[1]), ["saved", "declined", "proposed", "saved"], "newest first, and an unknown status reads as saved");
    assert.match(table, /<td class="mono muted">AGENTS\.md<\/td>/);
    assert.match(table, /Keep &lt;b&gt;short&lt;\/b&gt;/);
});

test("Save guideline posts the exact rendered lesson and leaves the proposal visible after failure", async () => {
    const calls: CapturedPost[] = [];
    const app = await loadApp({ fetch: async (url, init) => {
        calls.push([init?.method ?? "GET", url, requestBody(init)]);
        return jsonResponse({ error: { message: "automatic save unavailable" } }, 500);
    } });
    const rule = "Prefer <safe> & focused";
    app.state.review = reviewFixture({
        lessons: [{ lessonId: "lesson/one", threadId: "t1", scope: "personal", rule, status: "proposed", createdAt: "2026-01-01T00:00:00Z" }],
    });
    const message = () => app.run("messageHtml({ messageId: 'm', author: 'agent', body: 'Done', createdAt: '2026-01-02T00:00:00Z', lessonIds: ['lesson/one'] })");
    const html = message();
    assert.match(html, /Prefer &lt;safe&gt; &amp; focused/);
    const encodedProposal = required(html.match(/data-proposal="([^"]*)"/))[1];
    const renderedProposal = JSON.parse(encodedProposal
        .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&")) as { rule: string; scope: string };
    assert.deepEqual(renderedProposal, { rule, scope: "personal" });

    await clicker(app)("save-lesson", { lesson: "lesson/one", proposal: JSON.stringify(renderedProposal) });
    assert.deepEqual(calls, [["POST", "/api/lessons/lesson%2Fone/save", { rule, scope: "personal" }]]);
    assert.equal(app.node("#toast").textContent, "automatic save unavailable");
    assert.match(message(), /<span class="badge lesson-proposed"[^>]*>proposed<\/span> Prefer &lt;safe&gt; &amp; focused <button data-action="save-lesson"[^>]*>Save guideline<\/button>/);
});

test("the empty Lessons learned view explains the current auto-save setting", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const empty = (settings: RuntimeState["settings"]) => {
        app.state.settings = settings;
        return app.run("lessonsView()");
    };
    assert.match(empty(null), /Copilot proposes reusable guidelines when your feedback reveals a settled preference\. Use Save guideline in the thread to save one\./);
    assert.match(empty(settingsFixture()), /Copilot proposes reusable guidelines when your feedback reveals a settled preference\. Use Save guideline in the thread to save one\./);
    assert.match(empty(settingsFixture({ autoSaveLearnedRules: true })), /Copilot saves reusable guidelines here/);
});

test("an empty diff explains itself per scope, and only the pending scope offers the way back", async () => {
    const app = await loadApp();
    const empty = () => app.run("emptyDiffHtml()");
    app.state.review = reviewFixture({ scope: "pending", base: "origin/<main>" });
    assert.equal(empty(), "", "nothing is claimed before the snapshot loads");
    app.state.snapshot = { files: [{ path: "a.cs", hunks: [], additions: 1, deletions: 0 }] };
    assert.equal(empty(), "");

    app.state.snapshot = { files: [] };
    assert.match(empty(), /<strong>No uncommitted changes\.<\/strong>/);
    assert.match(empty(), /<button data-action="scope" data-scope="all">Switch to All changes<\/button>/);
    assert.match(app.run("overviewView()"), /^<div class="card empty-diff">/);
    app.run("renderSide()");
    assert.match(app.node("#side").innerHTML, /No uncommitted changes\./);

    for (const scope of ["all", undefined]) {
        app.state.review = reviewFixture({ scope, base: "origin/<main>" });
        const html = empty();
        assert.match(html, /<strong>No changes to review\.<\/strong> Nothing differs from origin\/&lt;main&gt;\./);
        assert.doesNotMatch(html, /<button/);
        app.run("renderSide()");
        assert.match(app.node("#side").innerHTML, /No changes against the base\./);
    }
});

test("switching scope loads the other review, remembers each review's own view, and never sticks in the switching state", async () => {
    const calls: string[] = [];
    const reviews: Record<string, ReturnType<typeof reviewFixture>> = {
        a: reviewFixture({ reviewId: "a", currentRevisionId: "ra" }),
        b: reviewFixture({ reviewId: "b", currentRevisionId: "rb", scope: "pending" }),
    };
    let current = "a";
    let failure: string | null = null;
    let settings: ReturnType<typeof settingsFixture> | undefined = settingsFixture({ configured: true });
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/state") return jsonResponse({ review: reviews[current], session: { busy: false }, settings });
        if (url.startsWith("/api/snapshot/")) return jsonResponse({ revisionId: url.split("/").pop(), files: [] });
        if (url === "/api/scope") {
            if (failure) return jsonResponse({ error: { message: failure } }, 500);
            current = requestBody(init).scope === "pending" ? "b" : "a";
            return jsonResponse({ reviewId: current });
        }
        throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    };
    const app = await loadApp({ fetch });
    const click = clicker(app);
    app.run("render = () => {}; var switchingSeen = []; var switchingSideHtml = []; renderTop = () => { switchingSeen.push(state.switching); }; renderSide = () => { switchingSideHtml.push(scopeToggleHtml(scopeOf(state.review))); };");

    await app.run("loadState()");
    assert.equal(app.state.review.reviewId, "a");
    assert.equal(required(app.state.snapshot).revisionId, "ra");

    app.run('navigate({ type: "file", path: "src/a.cs" })');
    app.run('state.open.add("line:src/a.cs:new:5-5"); state.expanded.add("t1"); state.fileFold.set("src/a.cs", true); state.content.set("ra:src/a.cs", {}); state.pendingJump = "t1"; collapsedDirs();');
    app.sessionStorage.items.set("sr:b:view", JSON.stringify({ type: "lessons" }));

    await click("scope", { scope: "pending" });
    assert.deepEqual(calls.slice(-3), ["POST /api/scope", "GET /api/state", "GET /api/snapshot/rb"]);
    assert.equal(app.state.review.reviewId, "b");
    assert.equal(required(app.state.snapshot).revisionId, "rb");
    assert.deepEqual(app.read("state.view"), { type: "lessons" }, "the other review restores its own view instead of inheriting this one");
    assert.deepEqual(app.read("[state.open.size, state.pending.size, state.expanded.size, state.fileFold.size, state.content.size]"), [0, 0, 0, 0, 0]);
    assert.equal(app.read("state.collapsedDirs"), null);
    assert.equal(app.read("state.pendingJump"), null);
    assert.equal(app.state.switching, false);
    const switchingSideHtml = app.read<string[]>("switchingSideHtml");
    assert.match(switchingSideHtml[0], /data-scope="all"[^>]* disabled/);
    assert.match(switchingSideHtml[0], /data-scope="pending"[^>]* disabled/);
    assert.doesNotMatch(switchingSideHtml[1], / disabled/, "the scope controls re-enable after the switch");

    const before = calls.length;
    await click("scope", { scope: "pending" });
    assert.equal(calls.length, before, "choosing the active scope does nothing");

    await app.run("loadState()");
    assert.deepEqual(calls.slice(before), ["GET /api/state"], "a refresh of the same review does not reload the snapshot");
    assert.deepEqual(app.read("state.view"), { type: "lessons" }, "and keeps the view");

    await click("scope", { scope: "all" });
    assert.equal(app.state.review.reviewId, "a");
    assert.deepEqual(app.read("state.view"), { type: "file", path: "src/a.cs" }, "switching back returns to where this review was left");

    failure = "boom";
    await click("scope", { scope: "pending" });
    assert.equal(app.state.review.reviewId, "a", "a failed switch stays on the current review");
    assert.equal(app.state.switching, false);
    assert.equal(app.node("#toast").textContent, "boom");
    assert.equal(app.node("#toast").className, "error");
    assert.deepEqual(app.read("switchingSeen"), [true, false, true, false, true, false]);

    settings = undefined;
    await app.run("loadState()");
    assert.equal(app.state.settings, null, "a server without settings hides the learning controls");
});

const userMessage = (messageId: string, state: string) => ({ messageId, author: "user", body: messageId, createdAt: "2026-01-01", delivery: { state } });
const draftThreads = () => [
    { threadId: "t1", kind: "overview", status: "active", messages: [userMessage("m1", "draft"), { messageId: "a1", author: "agent", body: "ok", createdAt: "2026-01-01" }, userMessage("m2", "draft")] },
    { threadId: "t2", kind: "overview", status: "active", messages: [userMessage("m3", "queued")] },
];

test("the top bar offers Submit review while drafts wait, and shows how comments reach Copilot", async () => {
    const app = await loadApp();
    const top = () => {
        app.run("renderTop()");
        return app.node("#top").innerHTML;
    };
    const footer = () => {
        app.run("renderLoadStatus()");
        return app.node("#review-status-controls").innerHTML;
    };
    app.state.settings = settingsFixture({ configured: true });
    app.state.review = reviewFixture({ threads: draftThreads() });

    let html = top();
    assert.match(html, /<button class="primary" data-action="submit-review"[^>]*>Submit review \(2\)<\/button>/, "agent replies and delivered comments are not drafts");
    app.state.submitting = true;
    html = top();
    assert.match(html, /data-action="submit-review"[^>]* disabled>Submitting…<\/button>/);
    assert.doesNotMatch(html, /Submit review \(/);
    app.state.submitting = false;
    app.state.review = reviewFixture({ threads: [draftThreads()[1]] });
    assert.doesNotMatch(top(), /submit-review/, "nothing to submit without drafts");

    for (const [delivery, deliveryMode, pill, reask] of [
        ["immediate", undefined, "Immediate", false],
        ["batch", "immediate", "Batch", false],
        ["ask", undefined, "Ask", false],
        ["ask", "batch", "Batch", true],
        ["ask", "immediate", "Immediate", true],
        ["unexpected", undefined, "Immediate", false],
    ]) {
        app.state.settings = settingsFixture({ configured: true, delivery });
        app.state.review = reviewFixture({ deliveryMode });
        html = top();
        assert.doesNotMatch(html, /Delivery:/);
        const footerHtml = footer();
        assert.doesNotMatch(footerHtml, /Delivery:/, `${delivery}/${deliveryMode}`);
        assert.equal(/data-action="delivery-reask"[^>]*>Change delivery</.test(footerHtml), reask, `only a decided ask-mode review offers Change delivery (${delivery}/${deliveryMode})`);
        if (reask) assert.match(footerHtml, new RegExp(`This review sends comments: ${pill}\\.`));
    }
    app.state.settings = null;
    app.state.review = reviewFixture({ threads: draftThreads() });
    html = top();
    assert.equal(footer(), "");
    assert.match(html, /Submit review \(2\)/, "a comment held on request can still be submitted without settings");
});

test("an ask-mode review asks how to send comments until the reviewer chooses", async () => {
    const app = await loadApp();
    const banner = (settings: RuntimeState["settings"], review: RuntimeState["review"] | null) => {
        app.state.settings = settings;
        if (review) app.state.review = review;
        else app.run("state.review = null");
        app.run("renderBanner()");
        return app.node("#banner");
    };
    const ask = settingsFixture({ configured: true, delivery: "ask" });

    const shown = banner(ask, reviewFixture());
    assert.equal(shown.hidden, false);
    assert.match(shown.innerHTML, /How should Copilot receive your comments on this review\?/);
    assert.match(shown.innerHTML, /Until you choose, new comments wait as drafts\./);
    assert.match(shown.innerHTML, /data-action="delivery-choose" data-mode="immediate"[^>]*>Send each now</);
    assert.match(shown.innerHTML, /data-action="delivery-choose" data-mode="batch"[^>]*>Batch into a review</);
    assert.match(banner(ask, reviewFixture({ threads: [draftThreads()[1], { threadId: "t3", messages: [userMessage("m4", "draft")] }] })).innerHTML, /1 draft comment is waiting\./);
    assert.match(banner(ask, reviewFixture({ threads: draftThreads() })).innerHTML, /2 draft comments are waiting\./);

    assert.equal(banner(ask, reviewFixture({ deliveryMode: "batch" })).hidden, true, "a decided review is not asked again");
    assert.equal(banner(ask, reviewFixture({ deliveryMode: "immediate" })).hidden, true);
    assert.equal(banner(settingsFixture({ configured: true, delivery: "batch" }), reviewFixture()).hidden, true);
    assert.equal(banner(null, reviewFixture()).hidden, true);
    assert.equal(banner(ask, null).hidden, true);

    const both = banner(settingsFixture({ delivery: "ask" }), reviewFixture());
    assert.equal(required(both.innerHTML.match(/class="banner-row"/g)).length, 2, "the learning and delivery questions can show together");
});

test("the composer and the draft badge follow the delivery mode", async () => {
    const app = await loadApp();
    const composer = () => app.run(`composerHtml("file:a.cs", { kind: "file", path: "a.cs" })`);
    const setMode = (delivery: string | null, deliveryMode?: string) => {
        app.state.settings = delivery ? settingsFixture({ configured: true, delivery }) : null;
        app.state.review = reviewFixture({ deliveryMode });
    };

    const composerModes: Array<[string | null, string | undefined, boolean, boolean | null]> = [
        [null, undefined, false, null],
        ["immediate", undefined, false, null],
        ["ask", "immediate", false, null],
        ["batch", undefined, true, true],
        ["ask", undefined, true, true],
        ["ask", "batch", true, true],
    ];
    for (const [delivery, deliveryMode, batching, defaultDraft] of composerModes) {
        const label = `${delivery}/${deliveryMode}`;
        setMode(delivery, deliveryMode);
        const html = composer();
        assert.equal(app.read("defaultDraft() ?? null"), defaultDraft, `immediate lets the server decide; otherwise the composer holds (${label})`);
        if (batching) {
            assert.match(html, /<button data-action="submit" data-key="file:a.cs" data-draft="0"[^>]*>Send now<\/button>/, label);
            assert.match(html, /<button class="primary" data-action="submit" data-key="file:a.cs" data-draft="1"[^>]*>Add to review<\/button>/, label);
            assert.match(html, /Ctrl\+Enter to add to review/, label);
        } else {
            assert.match(html, /<button class="primary" data-action="submit" data-key="file:a.cs"\s*>Comment<\/button>/, label);
            assert.doesNotMatch(html, /data-draft=|Add to review/, label);
            assert.match(html, /Ctrl\+Enter to send/, label);
        }
    }

    setMode("batch");
    app.run(`state.pending.set("file:a.cs", { sending: true })`);
    assert.match(composer(), /data-draft="0" title="[^"]*" disabled>Send now<\/button><button class="primary" [^>]*data-draft="1" title="[^"]*" disabled>Saving…<\/button>/);

    const badge = app.run(`deliveryHtml(${JSON.stringify(userMessage('m"1', "draft"))})`);
    assert.match(badge, /^<span class="delivery draft" title="Held until you submit the review">Draft · /);
    assert.match(badge, /<button class="link" data-action="send-draft" data-message="m&quot;1">Send now<\/button>/);
    assert.match(badge, /<button class="link" data-action="discard-draft" data-message="m&quot;1">Discard<\/button>/);
});

test("posting a comment sends the draft flag the clicked button chose, or lets the server decide", async () => {
    const posts: CapturedPost[] = [];
    let settings = settingsFixture({ configured: true, delivery: "batch" });
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        if (url === "/api/state") return jsonResponse({ review: reviewFixture(), session: { busy: false }, settings });
        if (url.startsWith("/api/snapshot/")) return jsonResponse({ revisionId: "r1", files: [] });
        posts.push([url, requestBody(init)]);
        return jsonResponse({ threadId: "t9", messageId: "m9", duplicate: false, draft: true });
    };
    const app = await loadApp({ fetch, CSS: { escape: (s: string) => s } });
    const click = clicker(app);
    app.run("render = () => {};");
    const box = (key: string, dataset: Record<string, string>) => {
        Object.assign(app.node(`.composer[data-key="${key}"]`), { dataset, querySelector: () => ({ value: " Rename this ", focus() {} }) });
    };
    box("file:a.cs", { kind: "file", path: "a.cs" });
    box("reply:t1", {});
    Object.assign(app.node('[data-thread-id="t9"]'), { classList: { add() {}, remove() {} } });
    await app.run("loadState()");

    const sent = async (dataset: Record<string, string>) => {
        await click("submit", dataset);
        const [url] = required(posts.at(-1));
        const body = capturedBody(posts);
        return [url, body.body, Object.hasOwn(body, "draft") ? body.draft : "server decides"];
    };
    assert.deepEqual(await sent({ key: "file:a.cs", draft: "1" }), ["/api/threads", "Rename this", true]);
    assert.deepEqual(await sent({ key: "file:a.cs", draft: "0" }), ["/api/threads", "Rename this", false]);
    assert.deepEqual(await sent({ key: "reply:t1", draft: "1" }), ["/api/threads/t1/messages", "Rename this", true]);
    assert.deepEqual(await sent({ key: "file:a.cs" }), ["/api/threads", "Rename this", true], "Ctrl+Enter in batch mode adds to the review");

    settings = settingsFixture({ configured: true, delivery: "immediate" });
    await app.run("loadState()");
    assert.deepEqual(await sent({ key: "reply:t1" }), ["/api/threads/t1/messages", "Rename this", "server decides"]);
    assert.equal(app.read("state.pending.size"), 0, "every post completed");
});

test("Send now, Discard, Submit review and the delivery question call the server and report the outcome", async () => {
    const calls: string[] = [];
    const replies = new Map();
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        if (url === "/api/state") {
            calls.push("GET /api/state");
            return jsonResponse({ review: reviewFixture({ threads: draftThreads() }), session: { busy: false }, settings: settingsFixture({ configured: true, delivery: "ask" }) });
        }
        if (url.startsWith("/api/snapshot/")) return jsonResponse({ revisionId: "r1", files: [] });
        calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
        const reply = replies.get(url);
        if (!reply) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
        return typeof reply === "function" ? reply() : reply;
    };
    const app = await loadApp({ fetch });
    const click = clicker(app);
    app.run("render = () => {}; var submittingSeen = []; renderTop = () => { submittingSeen.push(state.submitting); };");
    const toast = () => [app.node("#toast").textContent, app.node("#toast").className === "error"];
    const act = async (action: string, dataset: Record<string, string> = {}) => {
        const before = calls.length;
        await click(action, dataset);
        return calls.slice(before);
    };

    replies.set("/api/messages/m%3A1/send", jsonResponse({ delivered: true, sessionMessageId: "sm-1" }));
    assert.deepEqual(await act("send-draft", { message: "m:1" }), ["POST /api/messages/m%3A1/send {}", "GET /api/state"]);
    assert.deepEqual(toast(), ["Sent to Copilot", false]);
    replies.set("/api/messages/m%3A1/send", jsonResponse({ delivered: false, error: "session closed" }));
    await act("send-draft", { message: "m:1" });
    assert.deepEqual(toast(), ["session closed", true]);

    replies.set("/api/messages/m1/discard", jsonResponse({ threadId: "t1", threadRemoved: false }));
    assert.deepEqual(await act("discard-draft", { message: "m1" }), ["POST /api/messages/m1/discard {}", "GET /api/state"]);
    assert.deepEqual(toast(), ["Draft discarded", false]);

    for (const [submitted, text] of [[3, "Sent 3 comments to Copilot"], [1, "Sent 1 comment to Copilot"]]) {
        replies.set("/api/submit", jsonResponse({ submitted, delivered: true, sessionMessageId: "sm-2" }));
        assert.deepEqual(await act("submit-review"), ["POST /api/submit {}", "GET /api/state"]);
        assert.deepEqual(toast(), [text, false]);
    }
    assert.deepEqual(app.read("submittingSeen"), [true, true], "the button shows Submitting while the request is in flight");
    assert.equal(app.state.submitting, false);
    replies.set("/api/submit", jsonResponse({ submitted: 2, delivered: false, error: "session closed" }));
    await act("submit-review");
    assert.deepEqual(toast(), ["session closed", true]);
    replies.set("/api/submit", jsonResponse({ error: { message: "disk full" } }, 500));
    assert.deepEqual(await act("submit-review"), ["POST /api/submit {}", "GET /api/state"], "the review is reloaded even when the submission fails");
    assert.deepEqual(toast(), ["disk full", true]);
    assert.equal(app.state.submitting, false, "a failed submission never sticks in the submitting state");
    app.state.submitting = true;
    assert.deepEqual(await act("submit-review"), [], "a second click while submitting does nothing");
    app.state.submitting = false;

    const deliveryOutcomes: Array<[string, number, string]> = [
        ["immediate", 2, "Sending each comment now. Sent 2 waiting drafts."],
        ["immediate", 1, "Sending each comment now. Sent 1 waiting draft."],
        ["immediate", 0, "Sending each comment now"],
        ["batch", 0, "Batching comments. Submit the review when you are done."],
    ];
    for (const [mode, submitted, text] of deliveryOutcomes) {
        replies.set("/api/delivery", jsonResponse({ mode, submitted }));
        assert.deepEqual(await act("delivery-choose", { mode }), [`POST /api/delivery {"mode":"${mode}"}`, "GET /api/state"]);
        assert.deepEqual(toast(), [text, false], `${mode} ${submitted}`);
    }
    replies.set("/api/delivery", jsonResponse({ mode: "immediate", submitted: 2, error: "session closed" }));
    await act("delivery-choose", { mode: "immediate" });
    assert.deepEqual(toast(), ["Sending each comment now, but 2 waiting drafts could not be sent: session closed", true]);
    replies.set("/api/delivery", jsonResponse({ mode: null, submitted: 0 }));
    assert.deepEqual(await act("delivery-reask"), ['POST /api/delivery {"mode":null}', "GET /api/state"]);
});

const OLD_IMAGE = "1".repeat(40);
const NEW_IMAGE = "2".repeat(40);
const IMAGE_PATH = "art/logo.png";
type ImageFile = ReturnType<typeof parseUnifiedDiff>[number];
type LoadImage = (path: string, side: "old" | "new", oid: string) => Promise<void>;

async function imageReviewApp(globals: Record<string, unknown> = {}) {
    const app = await loadApp({ CSS: { escape: (value: string) => value }, ...globals });
    const [file] = parseUnifiedDiff(`diff --git a/${IMAGE_PATH} b/${IMAGE_PATH}\nindex ${OLD_IMAGE}..${NEW_IMAGE} 100644\nBinary files a/${IMAGE_PATH} and b/${IMAGE_PATH} differ\n`);
    app.state.review = reviewFixture();
    app.state.snapshot = { revisionId: "r1", files: [file] };
    return { app, file };
}

const setImage = (app: LoadedApp, side: "old" | "new", oid: string, entry: Record<string, unknown>, path = IMAGE_PATH) =>
    app.run(`state.images.set(imageKey(${JSON.stringify(path)}, "${side}", "${oid}"), ${JSON.stringify(entry)})`);
const imageEntry = (app: LoadedApp, path: string, side: "old" | "new", oid: string) =>
    app.read(`state.images.get(imageKey(${JSON.stringify(path)}, "${side}", "${oid}"))`);
const imageHtml = (app: LoadedApp, file: ImageFile) => app.run(`imageDiffHtml(${JSON.stringify(file)})`);
const readyImage = (width: number, height: number, size: number, url = "blob:image") => ({ status: "ready", url, width, height, size });

test("image previews show loading, size metadata and per-side fallbacks, offering comparison modes only for two different decoded images", async () => {
    const { app, file } = await imageReviewApp();
    assert.deepEqual(file.imageSides, { old: OLD_IMAGE, new: NEW_IMAGE });
    assert.deepEqual(app.read("[1023, 1024, 10 * 1024, 1.5 * 1024 * 1024].map(formatBytes)"), ["1023 B", "1.0 KB", "10 KB", "1.5 MB"]);

    let html = imageHtml(app, file);
    assert.match(html, /^<div class="image-diff" data-image-path="art\/logo.png" data-image-pending>/, "unloaded sides ask to be fetched near the viewport");
    assert.equal(html.match(/Loading preview…/g)?.length, 2);
    assert.doesNotMatch(html, /image-modes|<img/);

    setImage(app, "old", OLD_IMAGE, readyImage(640, 480, 2048));
    setImage(app, "new", NEW_IMAGE, { status: "failed" });
    html = imageHtml(app, file);
    assert.doesNotMatch(html, /data-image-pending|image-modes/);
    assert.match(html, /<figcaption class="old">Before <span class="image-meta">640 × 480 px · 2\.0 KB<\/span><\/figcaption><div class="image-stage"><img data-image-key="old:1{40}:art\/logo.png" alt="Before: art\/logo.png"><\/div>/);
    assert.match(html, /<figcaption class="new">After<\/figcaption><div class="image-stage"><p class="muted">Preview unavailable: /);

    setImage(app, "old", OLD_IMAGE, { status: "failed" });
    assert.match(imageHtml(app, file), /<div class="card muted">Binary file not shown\. Preview unavailable: /, "an unreadable image falls back to the binary message");

    setImage(app, "old", OLD_IMAGE, readyImage(640, 480, 2048));
    setImage(app, "new", NEW_IMAGE, readyImage(800, 600, 3 * 1024 * 1024));
    html = imageHtml(app, file);
    assert.match(html, /After <span class="image-meta">800 × 600 px · 3\.0 MB<\/span>/);
    assert.deepEqual([...html.matchAll(/data-mode="([^"]+)" aria-pressed="(true|false)">([^<]+)</g)].map((match) => match.slice(1)),
        [["2-up", "true", "2-up"], ["swipe", "false", "Swipe"], ["onion", "false", "Onion skin"]]);

    setImage(app, "old", NEW_IMAGE, readyImage(800, 600, 3 * 1024 * 1024));
    assert.doesNotMatch(imageHtml(app, { ...file, imageSides: { old: NEW_IMAGE, new: NEW_IMAGE } }), /image-modes/, "identical bytes have nothing to compare");
    html = imageHtml(app, { ...file, status: "added", oldPath: null, imageSides: { new: NEW_IMAGE } });
    assert.equal(html.match(/<figure>/g)?.length, 1);
    assert.doesNotMatch(html, /image-modes|Before/);
    setImage(app, "new", NEW_IMAGE, readyImage(0, 0, 512));
    html = imageHtml(app, file);
    assert.match(html, /After <span class="image-meta">512 B<\/span>/, "an image without intrinsic dimensions reports only its size");
    assert.doesNotMatch(html, /image-modes/);
});

test("swipe and onion skin stack both images on a stage sized to the larger one, and their sliders update the view in place", async () => {
    const { app, file } = await imageReviewApp();
    const click = clicker(app);
    setImage(app, "old", OLD_IMAGE, readyImage(400, 200, 100));
    setImage(app, "new", NEW_IMAGE, readyImage(800, 400, 100));
    await click("image-mode", { path: IMAGE_PATH, mode: "swipe" });
    assert.deepEqual(app.read(`state.imageViews.get("${IMAGE_PATH}")`), { mode: "swipe", split: 50, opacity: 50 });
    assert.ok(app.focused.includes(`.image-diff[data-image-path="${IMAGE_PATH}"] [data-action="image-mode"][data-mode="swipe"]`), "the pressed mode keeps focus");
    let html = imageHtml(app, file);
    assert.match(html, /aria-pressed="true">Swipe</);
    assert.match(html, /<div class="image-compare swipe" style="--split:50%;--opacity:50;aspect-ratio:800 \/ 400;width:min\(100%, 800px, calc\(50vh \* 800 \/ 400\)\)">/);
    assert.match(html, /<div class="image-layer old"><img data-image-key="old:1{40}:art\/logo.png" alt="Before: art\/logo.png" style="width:50%"><\/div><div class="image-layer new"><img data-image-key="new:2{40}:art\/logo.png" alt="After: art\/logo.png" style="width:100%"><\/div>/);
    assert.match(html, /<input type="range" class="image-swipe" min="0" max="100" value="50" aria-label="[^"]+" data-image-control="split" data-path="art\/logo.png">/);
    assert.match(html, /Before<\/span> 400 × 200 px · 100 B<\/span><span><span class="image-side-label new">After<\/span> 800 × 400 px · 100 B/);
    assert.doesNotMatch(html, /image-sides|data-image-control="opacity"/);

    const properties: [string, string][] = [];
    const stage = Object.assign(new MockElement(), { style: { setProperty: (name: string, value: string) => properties.push([name, value]) } });
    const slide = (control: string, value: string) => {
        const input = Object.assign(new MockElement("INPUT"), { value, dataset: { imageControl: control, path: IMAGE_PATH } });
        input.closest = () => Object.assign(new MockElement(), { querySelector: () => stage });
        return app.run("onInput")({ target: input });
    };
    slide("split", "120");
    slide("split", "-5");
    assert.deepEqual(properties, [["--split", "100%"], ["--split", "0%"]], "dragging restyles the stage without re-rendering it");
    assert.equal(app.read(`state.imageViews.get("${IMAGE_PATH}").split`), 0);

    await click("image-mode", { path: IMAGE_PATH, mode: "onion" });
    slide("opacity", "25");
    assert.deepEqual(properties.at(-1), ["--opacity", "25"]);
    html = imageHtml(app, file);
    assert.match(html, /<div class="image-compare onion" style="--split:0%;--opacity:25;/);
    assert.match(html, /<input type="range" min="0" max="100" value="25" aria-label="After image opacity" data-image-control="opacity"/);
    assert.doesNotMatch(html, /image-swipe/);
    await click("image-mode", { path: IMAGE_PATH, mode: "unknown" });
    assert.deepEqual(app.read(`state.imageViews.get("${IMAGE_PATH}")`), { mode: "onion", split: 0, opacity: 25 });
});

test("an SVG keeps its textual diff below the preview and falls back to its source when the preview is unavailable", async () => {
    const { app } = await imageReviewApp();
    const [svg] = parseUnifiedDiff(`diff --git a/art/icon.svg b/art/icon.svg\nnew file mode 100644\nindex 0000000..${NEW_IMAGE}\n--- /dev/null\n+++ b/art/icon.svg\n@@ -0,0 +1 @@\n+<svg xmlns="http://www.w3.org/2000/svg"/>\n`);
    svg.imageSides = { new: NEW_IMAGE };
    app.state.snapshot = { revisionId: "r1", files: [svg] };
    app.state.files = [svg];
    let html = app.run(`fileView(${JSON.stringify(svg)}, { stacked: true })`);
    assert.ok(html.includes('class="image-diff"') && html.indexOf('class="image-diff"') < html.indexOf('<tr class="row '), "the preview precedes the source diff");
    setImage(app, "new", NEW_IMAGE, { status: "failed" }, "art/icon.svg");
    html = app.run(`fileView(${JSON.stringify(svg)}, { stacked: true })`);
    assert.match(html, /<div class="card muted">Preview unavailable: /);
    assert.doesNotMatch(html, /Binary file not shown/);
    assert.match(html, /<tr class="row /);
});

test("images load as data: URLs for SVG and revocable blob: URLs otherwise, failing closed and pruning stale entries", async () => {
    const requests: string[] = [];
    const bodies: Record<string, Blob> = {
        "art/icon.svg": new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: "image/svg+xml" }),
        [IMAGE_PATH]: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
    };
    let decodeFails = false;
    class FakeImage {
        src = "";
        naturalWidth = 0;
        naturalHeight = 0;
        async decode() {
            if (decodeFails) throw new Error("EncodingError");
            [this.naturalWidth, this.naturalHeight] = [24, 12];
        }
    }
    class FakeFileReader {
        result: string | null = null;
        error: Error | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(blob: Blob) {
            void blob.arrayBuffer().then((bytes) => {
                this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
                this.onload?.();
            });
        }
    }
    const fetch = async (url: string) => {
        if (url === "/api/refresh") return jsonResponse({});
        requests.push(url);
        const body = bodies[new URLSearchParams(url.split("?")[1]).get("path") ?? ""];
        return body ? { ok: true, blob: async () => body } : { ok: false, status: 404, statusText: "Not Found" };
    };
    const { app } = await imageReviewApp({ fetch, Image: FakeImage, FileReader: FakeFileReader });
    const loadImage = app.run<LoadImage>("loadImage");
    const SVG_IMAGE = "3".repeat(40);
    const BROKEN_IMAGE = "4".repeat(40);

    await loadImage("art/icon.svg", "new", SVG_IMAGE);
    assert.equal(requests[0], "/api/diff-image/r1?review=r&path=art%2Ficon.svg&side=new");
    const svgUrl = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")}`;
    assert.deepEqual(imageEntry(app, "art/icon.svg", "new", SVG_IMAGE), readyImage(24, 12, bodies["art/icon.svg"].size, svgUrl), "SVG never gets a same-origin URL");

    // Another path with the same bytes whose working-tree file changed after capture.
    await loadImage("stale.png", "new", NEW_IMAGE);
    assert.deepEqual(imageEntry(app, "stale.png", "new", NEW_IMAGE), { status: "failed" });
    await loadImage(IMAGE_PATH, "new", NEW_IMAGE);
    const pngUrl = app.read<{ url: string }>(`state.images.get(imageKey("${IMAGE_PATH}", "new", "${NEW_IMAGE}"))`).url;
    assert.match(pngUrl, /^blob:/, "one path's failure does not hide another path with identical bytes");
    assert.ok(resolveObjectURL(pngUrl));
    await loadImage(IMAGE_PATH, "new", NEW_IMAGE);
    assert.equal(requests.length, 3, "a cached image is not fetched again");

    await loadImage("missing.png", "old", OLD_IMAGE);
    assert.deepEqual(imageEntry(app, "missing.png", "old", OLD_IMAGE), { status: "failed" });
    decodeFails = true;
    await loadImage(IMAGE_PATH, "old", BROKEN_IMAGE);
    assert.deepEqual(imageEntry(app, IMAGE_PATH, "old", BROKEN_IMAGE), { status: "failed" });

    const key = (path: string, side: string, oid: string) => `${side}:${oid}:${path}`;
    app.state.snapshot = { revisionId: "r1", files: [
        { path: "art/icon.svg", imageSides: { new: SVG_IMAGE } },
        { path: IMAGE_PATH, imageSides: { old: BROKEN_IMAGE, new: NEW_IMAGE } },
        { path: "stale.png", imageSides: { new: NEW_IMAGE } },
        { path: "missing.png", imageSides: { old: OLD_IMAGE } },
    ] };
    app.run("loadState = async () => {}");
    await app.run<Promise<void>>("refreshReview()");
    assert.deepEqual(app.read("[...state.images.keys()]"), [key("art/icon.svg", "new", SVG_IMAGE), key(IMAGE_PATH, "new", NEW_IMAGE)],
        "a Refresh that keeps the revision still retries failed images");

    // The next revision references the SVG and the missing image; only decoded images it still shows survive.
    app.run(`pruneImages({ files: [{ path: "art/icon.svg", imageSides: { new: "${SVG_IMAGE}" } }, { path: "missing.png", imageSides: { old: "${OLD_IMAGE}" } }] })`);
    assert.deepEqual(app.read("[...state.images.keys()]"), [key("art/icon.svg", "new", SVG_IMAGE)]);
    assert.equal(resolveObjectURL(pngUrl), undefined, "an image no longer shown releases its blob URL");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = await imageReviewApp({ fetch: async (url: string) => { await gate; return fetch(url); }, Image: FakeImage });
    decodeFails = false;
    const loadSlowly = slow.app.run<LoadImage>("loadImage");
    const pending = [loadSlowly(IMAGE_PATH, "new", NEW_IMAGE), loadSlowly("old/logo.png", "new", OLD_IMAGE)];
    assert.deepEqual(imageEntry(slow.app, IMAGE_PATH, "new", NEW_IMAGE), { status: "loading" });
    // The next revision renamed old/logo.png to new/logo.png, whose bytes the pending request can no longer read.
    slow.app.run(`pruneImages({ files: [{ path: "new/logo.png", imageSides: { new: "${OLD_IMAGE}" } }] })`);
    release();
    await Promise.all(pending);
    assert.deepEqual(slow.app.read("[...state.images.keys()]"), [], "a load that finishes after its revision moved on is discarded, so a renamed image is fetched at its new path");
});
