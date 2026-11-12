import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkBundledSkillUpdates, DEFAULT_MANIFEST, formatReport } from "../scripts/check-bundled-skill-updates.mjs";

const root = join(DEFAULT_MANIFEST, "..");
interface ManifestSkill {
    name: string;
    path: string;
    upstream: { repository: string; path: string; release?: string };
}

interface BundleManifest {
    skills: ManifestSkill[];
}

const manifest = JSON.parse(await readFile(DEFAULT_MANIFEST, "utf8")) as BundleManifest;
const bundled: Record<string, string> = Object.fromEntries(await Promise.all(manifest.skills.map(async (skill) =>
    [skill.upstream.path, await readFile(join(root, skill.path), "utf8")] as const)));
const ADDY = "/repos/addyosmani/agent-skills";
const PONY = "/repos/DietrichGebert/ponytail";

function required<T>(value: T | null | undefined): T {
    assert.ok(value);
    return value;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

function mockFetch(routes: Record<string, Response | Error>) {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = String(url).replace("https://api.github.com", "");
        calls.push({ path, init });
        const route = routes[path];
        if (route instanceof Error) throw route;
        return route?.clone() ?? json({ message: "Not Found" }, 404);
    };
    return { fetch, calls };
}

const pinnedRoutes = (repo: string, release: string, commit: string, files: ReadonlyArray<readonly [string, string | undefined]>) => ({
    [`${repo}/releases/latest`]: json({ tag_name: release, published_at: "2026-01-01T00:00:00Z" }),
    [`${repo}/commits/${encodeURIComponent(release)}`]: json({ sha: commit }),
    ...Object.fromEntries(files.map(([filePath, text]) => [`${repo}/contents/${filePath}?ref=${commit}`, json(text)])),
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
    assert.equal(new Headers(required(required(calls[0]).init).headers).get("Authorization"), "Bearer t");
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
    assert.match(limited.results[0].error ?? "", /rate limit exceeded .*GITHUB_TOKEN/);
    assert.match(limited.results[2].error ?? "", /DietrichGebert\/ponytail has no published GitHub release/);
    assert.match(formatReport(limited.results), /CHECK FAILED/);

    const offline = await checkBundledSkillUpdates({ fetch: mockFetch({ [`${ADDY}/releases/latest`]: new Error("ECONNRESET"), ...ponyPinned() }).fetch });
    assert.equal(offline.exitCode, 2);
    assert.match(offline.results[0].error ?? "", /network error .*ECONNRESET/);
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
    assert.match(behind.results[0].error ?? "", /0\.6\.14 is not newer than pinned 0\.6\.15/);
});

test("a newer release tag on the pinned commit is newer-release-unchanged, and unorderable tags are errors", async () => {
    const pinnedCommit = "8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e";
    const sameCommit = (tag: string) => pinnedRoutes(ADDY, tag, pinnedCommit, [
        ["skills/code-review-and-quality/SKILL.md", bundled["skills/code-review-and-quality/SKILL.md"]],
        ["skills/code-simplification/SKILL.md", bundled["skills/code-simplification/SKILL.md"]],
    ]);
    const retagged = await checkBundledSkillUpdates({ fetch: mockFetch({ ...sameCommit("0.6.16"), ...ponyPinned() }).fetch });
    assert.equal(retagged.exitCode, 1);
    assert.deepEqual(retagged.results.map((r) => r.status), ["newer-release-unchanged", "newer-release-unchanged", "current"]);

    const unordered = await checkBundledSkillUpdates({ fetch: mockFetch({ ...sameCommit("stable"), ...ponyPinned() }).fetch });
    assert.equal(unordered.exitCode, 2);
    assert.match(unordered.results[0].error ?? "", /cannot establish whether .*stable is newer than pinned 0\.6\.15/);

    const moved = await checkBundledSkillUpdates({ fetch: mockFetch({
        ...pinnedRoutes(ADDY, "0.6.15", "cccccccccccccccccccccccccccccccccccccccc", []),
        ...ponyPinned(),
    }).fetch });
    assert.equal(moved.exitCode, 2);
    assert.match(moved.results[0].error ?? "", /release 0\.6\.15 now points to c+, not the pinned/);
});

test("pins with different release tags on the same commit are classified independently in either order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-pins-"));
    try {
        await cp(root, dir, { recursive: true });
        const olderPin = structuredClone(manifest);
        const simplification = olderPin.skills.find((skill) => skill.name === "code-simplification");
        assert.ok(simplification);
        simplification.upstream.release = "0.6.14";
        const addy = olderPin.skills.filter((s) => s.upstream.repository.includes("agent-skills"));
        const pony = olderPin.skills.filter((s) => !s.upstream.repository.includes("agent-skills"));
        for (const order of [addy, [...addy].reverse()]) {
            const manifestPath = join(dir, "manifest.json");
            await writeFile(manifestPath, JSON.stringify({ ...olderPin, skills: [...order, ...pony] }));
            const { fetch, calls } = mockFetch({ ...addyPinned(), ...ponyPinned() });
            const { results, exitCode } = await checkBundledSkillUpdates({ manifestPath, fetch });
            const status = Object.fromEntries(results.map((r) => [r.name, r.status]));
            assert.deepEqual(status, { "code-review-and-quality": "current", "code-simplification": "newer-release-unchanged", "ponytail-review": "current" });
            assert.equal(exitCode, 1);
            assert.equal(calls.filter((c) => c.path === `${ADDY}/releases/latest`).length, 2, "distinct pins are looked up separately");
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
