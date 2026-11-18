import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadApp, MockElement } from "./load-app.mjs";

type Result = { isFinal: boolean; 0: { transcript: string } };
const segment = (transcript: string, isFinal = true): Result => ({ isFinal, 0: { transcript } });

async function fixture(
    support: "standard" | "prefixed" | "cloud-only" | "none",
    check: () => Promise<string> = async () => "available",
    acceptLocal = true,
    install: () => Promise<boolean> = async () => { throw new Error("Unexpected language pack setup"); },
) {
    const instances: Recognition[] = [];
    const checks: Array<{ langs: string[]; processLocally: boolean }> = [];
    const starts: Array<{ lang: string; local: boolean }> = [];
    const installs: Array<{ langs: string[]; processLocally: boolean }> = [];
    class Recognition {
        static available(options: { langs: string[]; processLocally: boolean }) {
            checks.push({ ...options, langs: [...options.langs] });
            return check();
        }
        static install(options: { langs: string[]; processLocally: boolean }) {
            installs.push({ ...options, langs: [...options.langs] });
            return install();
        }
        lang = "";
        #local = false;
        get processLocally() { return this.#local; }
        set processLocally(value: boolean) { if (acceptLocal) this.#local = value; }
        onstart?: () => void;
        onend?: () => void;
        onresult?: (event: { resultIndex: number; results: Result[] }) => void;
        onerror?: (event: { error: string }) => void;
        stops = 0;
        aborts = 0;
        constructor() { instances.push(this); }
        start() { starts.push({ lang: this.lang, local: this.processLocally }); }
        stop() { this.stops++; }
        abort() { this.aborts++; }
    }
    class CloudOnlyRecognition {
        constructor() { throw new Error("Cloud-only recognition must not be instantiated"); }
    }

    const storage = new Map<string, string>();
    const makeComposer = () => {
        const textarea = { dataset: { composer: "" }, value: "", disabled: false, closest: () => null };
        const button = {
            tagName: "BUTTON", dataset: { action: "dictate", key: "" }, textContent: "",
            attrs: new Map<string, string>(),
            setAttribute(name: string, value: string) { this.attrs.set(name, value); },
            closest() { return this; },
        };
        const status = { textContent: "" };
        const setup = { ...button, dataset: { ...button.dataset, action: "install-dictation-model" }, hidden: true };
        return {
            textarea, button, setup, status,
            querySelector(selector: string) {
                if (selector === "textarea") return textarea;
                if (selector === "[data-dictation-status]") return status;
                if (selector === '[data-action="dictate"]') return button;
                if (selector === '[data-action="install-dictation-model"]') return setup;
                return null;
            },
        };
    };
    const composers = new Map(["overview", "reply:t1"].map((key) => {
        const composer = makeComposer();
        composer.setup.dataset.key = composer.button.dataset.key = composer.textarea.dataset.composer = key;
        return [key, composer];
    }));
    const top = new MockElement();
    const context = vm.createContext({
        URLSearchParams, DOMException, CSS: { escape: (text: string) => text }, location: { search: "" },
        window: { setTimeout: () => 0 },
        SpeechRecognition: support === "standard" ? Recognition : support === "cloud-only" ? CloudOnlyRecognition : undefined,
        webkitSpeechRecognition: support === "prefixed" ? Recognition : undefined,
        navigator: { language: "en-GB" },
        document: {
            addEventListener() {},
            querySelector: (selector: string) => selector === "#top" ? top : composers.get(/^\.composer\[data-key="(.+)"\]$/.exec(selector)?.[1] ?? "") ?? null,
        },
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
        fetch: () => { throw new Error("Dictation must not send requests"); },
        requestAnimationFrame: () => 0,
        setInterval() {},
    });
    await loadApp(context);
    const run = <T,>(code: string): T => vm.runInContext(code, context) as T;
    run('state.review = { reviewId: "review", currentRevisionId: "r1" }');
    const overview = composers.get("overview")!;
    const reply = composers.get("reply:t1")!;
    return {
        overview, reply, instances, checks, starts, installs,
        click: (button: typeof overview.button, isTrusted = true) => run<(event: unknown) => Promise<void>>("onClick")({ target: button, isTrusted }),
        type: (textarea: typeof overview.textarea, value: string) => {
            textarea.value = value;
            run<(event: unknown) => void>("onInput")({ target: textarea });
        },
        draft: (key: string) => run<string>(`getDraft(${JSON.stringify(key)})`),
        markup: (key: string) => run<string>(`composerHtml(${JSON.stringify(key)}, { alwaysOpen: true })`),
        close: (key: string) => run(`closeComposer(${JSON.stringify(key)}, true)`),
    };
}

test("dictation appends only final speech to the active draft, even while typing or stopping", async () => {
    const { click, overview, reply, instances, draft, markup, type, checks, starts } = await fixture("standard");
    type(overview.textarea, "Other draft");
    type(reply.textarea, "Existing\n");
    assert.match(markup("reply:t1"), /role="status"[\s\S]*>Dictate<\/button>/);
    await click(reply.button);
    assert.deepEqual(checks, [{ langs: ["en-GB"], processLocally: true }]);
    assert.deepEqual(starts, [{ lang: "en-GB", local: true }]);
    const [speech] = instances;
    speech.onstart?.();
    assert.equal(reply.status.textContent, "Listening on this device…");
    assert.equal(reply.button.textContent, "Stop dictation");
    speech.onresult?.({ resultIndex: 0, results: [segment("tentative", false)] });
    assert.equal(draft("reply:t1"), "Existing\n");
    const first = segment(" first ");
    speech.onresult?.({ resultIndex: 0, results: [first] });
    type(reply.textarea, `${reply.textarea.value} plus typing`);
    await click(reply.button);
    await click(reply.button);
    assert.equal(speech.stops, 1);
    assert.equal(reply.button.attrs.get("aria-disabled"), "true");
    speech.onresult?.({ resultIndex: 1, results: [first, segment("last")] });
    speech.onend?.();
    assert.equal(reply.textarea.value, "Existing\nfirst plus typing last");
    assert.equal(draft("reply:t1"), reply.textarea.value);
    assert.equal(draft("overview"), "Other draft");
    assert.equal(reply.button.textContent, "Dictate");
    assert.equal(reply.button.attrs.get("aria-disabled"), "false");
});

test("permission denial preserves the draft and reports how to continue", async () => {
    const { click, overview, instances, draft, type } = await fixture("prefixed");
    type(overview.textarea, "Original");
    await click(overview.button);
    instances[0].onerror?.({ error: "not-allowed" });
    instances[0].onend?.();
    assert.match(overview.status.textContent, /microphone permissions.*still type/);
    assert.equal(overview.button.textContent, "Dictate");
    assert.equal(draft("overview"), "Original");
    type(overview.textarea, "Original, with more typing");
    assert.equal(draft("overview"), "Original, with more typing");
});

test("switching composers or closing one aborts recognition and ignores late results", async () => {
    const { click, close, overview, reply, instances, draft } = await fixture("standard");
    await click(overview.button);
    await click(reply.button);
    assert.equal(instances[0].aborts, 1);
    instances[0].onresult?.({ resultIndex: 0, results: [segment("old result")] });
    close("reply:t1");
    assert.equal(instances[1].aborts, 1);
    instances[1].onresult?.({ resultIndex: 0, results: [segment("late result")] });
    assert.equal(draft("overview"), "");
    assert.equal(draft("reply:t1"), "");
});

test("absent or cloud-only APIs keep the normal composer and typing", async () => {
    for (const support of ["none", "cloud-only"] as const) {
        const { overview, click, starts, draft, markup, type } = await fixture(support);
        assert.doesNotMatch(markup("overview"), /data-action="dictate"/);
        assert.match(markup("overview"), /<textarea[\s\S]*On-device dictation is unavailable[\s\S]*data-action="submit"/);
        await click(overview.button);
        type(overview.textarea, "Typed normally");
        assert.equal(draft("overview"), "Typed normally");
        assert.deepEqual(starts, []);
    }
});

test("unavailable models, rejected policy checks, and an ignored local setting never start recording", async () => {
    const cases: Array<[() => Promise<string>, boolean, RegExp]> = [
        [async () => "downloading", true, /still downloading/],
        [async () => "unavailable", true, /unavailable for en-GB/],
        [async () => { throw new Error("Host policy"); }, true, /could not check/],
        [async () => "available", false, /could not enable on-device recognition/],
    ];
    for (const [check, acceptLocal, message] of cases) {
        const { overview, click, starts, installs, draft, type } = await fixture("standard", check, acceptLocal);
        type(overview.textarea, "Keep this draft");
        await click(overview.button);
        assert.match(overview.status.textContent, message);
        assert.equal(draft("overview"), "Keep this draft");
        assert.deepEqual(starts, []);
        assert.deepEqual(installs, []);
        assert.ok(overview.setup.hidden);
    }
});

test("a fresh origin can set up its local pack only by explicit action and must click Dictate again", async () => {
    let authorized = false;
    const { click, overview, starts, installs, draft, type } = await fixture(
        "standard", async () => authorized ? "available" : "downloadable", true, async () => { authorized = true; return true; },
    );
    type(overview.textarea, "Existing draft");
    await click(overview.button);
    assert.match(overview.status.textContent, /may download a language pack/);
    assert.equal(overview.setup.hidden, false);
    assert.deepEqual(installs, []);
    await click(overview.setup, false);
    assert.deepEqual(installs, []);
    const setup = click(overview.setup);
    assert.deepEqual(installs, [{ langs: ["en-GB"], processLocally: true }], "install is called in the setup click before any await");
    await setup;
    assert.match(overview.status.textContent, /Click Dictate/);
    assert.deepEqual(starts, []);
    await click(overview.button);
    assert.deepEqual(starts, [{ lang: "en-GB", local: true }]);
    assert.equal(draft("overview"), "Existing draft");
});

test("declined or policy-blocked pack setup does not start recognition", async () => {
    for (const [install, message] of [
        [async () => false, /declined or could not finish/],
        [async () => { throw new DOMException("Blocked", "NotAllowedError"); }, /did not allow language pack setup/],
    ] as const) {
        const { click, overview, starts, installs, draft, type } = await fixture("standard", async () => "downloadable", true, install);
        type(overview.textarea, "Existing draft");
        await click(overview.button);
        await click(overview.setup);
        assert.match(overview.status.textContent, message);
        assert.equal(draft("overview"), "Existing draft");
        assert.deepEqual(starts, []);
        await click(overview.button);
        assert.equal(installs.length, 1, "retrying recognition doesn't retry the download");
    }
});

test("closing the composer while the browser checks a model prevents a late microphone start", async () => {
    let resolve!: (value: string) => void;
    const availability = new Promise<string>((done) => { resolve = done; });
    const { overview, click, close, starts } = await fixture("standard", () => availability);
    const checking = click(overview.button);
    assert.equal(overview.button.textContent, "Cancel dictation");
    close("overview");
    resolve("available");
    await checking;
    assert.deepEqual(starts, []);
});
