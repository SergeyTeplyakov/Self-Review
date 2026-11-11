import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { checkBundledSkillUpdates, DEFAULT_MANIFEST, formatReport } from "../scripts/check-bundled-skill-updates.mjs";

const root = join(DEFAULT_MANIFEST, "..");
const manifest = JSON.parse(await readFile(DEFAULT_MANIFEST, "utf8"));
const bundled = Object.fromEntries(await Promise.all(manifest.skills.map(async (s) => [s.upstream.path, await readFile(join(root, s.path), "utf8")])));
const ADDY = "/repos/addyosmani/agent-skills";
const PONY = "/repos/DietrichGebert/ponytail";

const json = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function mockFetch(routes) {
    const calls = [];
    const fetch = async (url, init) => {
        const path = url.replace("https://api.github.com", "");
        calls.push({ path, init });
        const route = routes[path];
        if (route instanceof Error) throw route;
        return route ?? json({ message: "Not Found" }, 404);
    };
    return { fetch, calls };
}

const pinnedRoutes = (repo, release, commit, files) => ({
    [`${repo}/releases/latest`]: json({ tag_name: release, published_at: "2026-01-01T00:00:00Z" }),
    [`${repo}/commits/${encodeURIComponent(release)}`]: json({ sha: commit }),
    ...Object.fromEntries(files.map(([path, text]) => [`${repo}/contents/${path}?ref=${commit}`, json(text)])),
});

const addyPinned = () => pinnedRoutes(ADDY, "0.6.15", "8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e", [
    ["skills/code-review-and-quality/SKILL.md", bundled["skills/code-review-and-quality/SKILL.md"]],
    ["skills/code-simplification/SKILL.md", bundled["skills/code-simplification/SKILL.md"]],
]);
const ponyPinned = () => pinnedRoutes(PONY, "v5.3.3", "7801d061243d7b753bad0e0b3c057cd250b11755", [
    ["skills/ponytail-review/SKILL.md", bundled["skills/ponytail-review/SKILL.md"]],
]);

test("bundled skills on the latest release report current, with one release lookup per repository", async () => {
    const before = await readFile(DEFAULT_MANIFEST, "utf8");
    const { fetch, calls } = mockFetch({ ...addyPinned(), ...ponyPinned() });
    const { results, exitCode } = await checkBundledSkillUpdates({ fetch, token: "t" });
    assert.equal(exitCode, 0);
    assert.deepEqual(results.map((r) => r.status), ["current", "current", "current"]);
    assert.equal(calls.filter((c) => c.path.endsWith("/releases/latest")).length, 2);
    assert.equal(calls[0].init.headers.Authorization, "Bearer t");
    assert.equal(await readFile(DEFAULT_MANIFEST, "utf8"), before);
    assert.match(formatReport(results), /up to date with latest release 0\.6\.15/);
});

test("a newer release reports changed and unchanged skill content separately", async () => {
    const next = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { fetch } = mockFetch({
        ...pinnedRoutes(ADDY, "0.7.0", next, [
            ["skills/code-review-and-quality/SKILL.md", "# changed upstream\n"],
            ["skills/code-simplification/SKILL.md", bundled["skills/code-simplification/SKILL.md"].replace(/\r\n/g, "\n")],
        ]),
        [`${ADDY}/compare/8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e...${next}`]: json({ status: "ahead" }),
        ...ponyPinned(),
    });
    const { results, exitCode } = await checkBundledSkillUpdates({ fetch });
    assert.equal(exitCode, 1);
    assert.deepEqual(results.map((r) => [r.status, r.latestRelease]), [
        ["update-available", "0.7.0"], ["newer-release-unchanged", "0.7.0"], ["current", "v5.3.3"],
    ]);
    const report = formatReport(results);
    assert.match(report, /code-review-and-quality \(pinned 0\.6\.15\): newer release 0\.7\.0 is available and the skill content changed/);
    assert.match(report, /code-simplification .*skill content is unchanged/);
});

test("missing releases, rate limits, network failures and non-ahead releases are errors, never up to date", async () => {
    const { fetch } = mockFetch({
        [`${ADDY}/releases/latest`]: json({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" }),
    });
    const limited = await checkBundledSkillUpdates({ fetch });
    assert.equal(limited.exitCode, 2);
    assert.deepEqual(limited.results.map((r) => r.status), ["error", "error", "error"]);
    assert.match(limited.results[0].error, /rate limit exceeded .*GITHUB_TOKEN/);
    assert.match(limited.results[2].error, /DietrichGebert\/ponytail has no published GitHub release/);
    assert.match(formatReport(limited.results), /CHECK FAILED/);

    const offline = await checkBundledSkillUpdates({ fetch: mockFetch({ [`${ADDY}/releases/latest`]: new Error("ECONNRESET"), ...ponyPinned() }).fetch });
    assert.equal(offline.exitCode, 2);
    assert.match(offline.results[0].error, /network error .*ECONNRESET/);
    assert.equal(offline.results[2].status, "current");

    const old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const behind = await checkBundledSkillUpdates({ fetch: mockFetch({
        ...pinnedRoutes(ADDY, "0.6.14", old, [
            ["skills/code-review-and-quality/SKILL.md", bundled["skills/code-review-and-quality/SKILL.md"]],
            ["skills/code-simplification/SKILL.md", bundled["skills/code-simplification/SKILL.md"]],
        ]),
        [`${ADDY}/compare/8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e...${old}`]: json({ status: "behind" }),
        ...ponyPinned(),
    }).fetch });
    assert.equal(behind.exitCode, 2);
    assert.match(behind.results[0].error, /0\.6\.14 is not newer than pinned 0\.6\.15/);
});

test("a newer release tag on the pinned commit is newer-release-unchanged, and unorderable tags are errors", async () => {
    const pinnedCommit = "8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e";
    const sameCommit = (tag) => pinnedRoutes(ADDY, tag, pinnedCommit, [
        ["skills/code-review-and-quality/SKILL.md", bundled["skills/code-review-and-quality/SKILL.md"]],
        ["skills/code-simplification/SKILL.md", bundled["skills/code-simplification/SKILL.md"]],
    ]);
    const retagged = await checkBundledSkillUpdates({ fetch: mockFetch({ ...sameCommit("0.6.16"), ...ponyPinned() }).fetch });
    assert.equal(retagged.exitCode, 1);
    assert.deepEqual(retagged.results.map((r) => r.status), ["newer-release-unchanged", "newer-release-unchanged", "current"]);

    const unordered = await checkBundledSkillUpdates({ fetch: mockFetch({ ...sameCommit("stable"), ...ponyPinned() }).fetch });
    assert.equal(unordered.exitCode, 2);
    assert.match(unordered.results[0].error, /cannot establish whether .*stable is newer than pinned 0\.6\.15/);

    const moved = await checkBundledSkillUpdates({ fetch: mockFetch({
        ...pinnedRoutes(ADDY, "0.6.15", "cccccccccccccccccccccccccccccccccccccccc", []),
        ...ponyPinned(),
    }).fetch });
    assert.equal(moved.exitCode, 2);
    assert.match(moved.results[0].error, /release 0\.6\.15 now points to c+, not the pinned/);
});
