#!/usr/bin/env node
// Read-only check of bundled review skills against the latest published upstream
// GitHub releases. Never modifies the bundle. Exit codes: 0 = every skill is on
// the latest release, 1 = a newer release exists, 2 = a check could not complete.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = resolve(here, "../bundled-skills/manifest.json");
const API = "https://api.github.com";

export const sha256Text = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

function parseRepository(url) {
    const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url ?? "");
    if (!match) throw new Error(`unsupported upstream repository URL: ${url}`);
    return { owner: match[1], repo: match[2] };
}

class GitHubClient {
    constructor({ fetch, token }) {
        this.fetch = fetch;
        this.token = token;
    }

    async request(path, { raw = false, notFound } = {}) {
        const headers = {
            Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
            "User-Agent": "self-review-skill-update-check",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        let response;
        try {
            response = await this.fetch(`${API}${path}`, { headers });
        } catch (error) {
            throw new Error(`network error for ${path}: ${error?.message ?? error}`);
        }
        if (response.status === 404 && notFound) throw new Error(notFound);
        if ((response.status === 403 || response.status === 429) && response.headers?.get?.("x-ratelimit-remaining") === "0") {
            const reset = Number(response.headers.get("x-ratelimit-reset"));
            const when = Number.isFinite(reset) && reset > 0 ? ` (resets ${new Date(reset * 1000).toISOString()})` : "";
            throw new Error(`GitHub API rate limit exceeded${when}; set GITHUB_TOKEN or GH_TOKEN to raise the limit`);
        }
        if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
        return raw ? response.text() : response.json();
    }
}

async function checkRepository(client, repository, pinned) {
    const { owner, repo } = parseRepository(repository);
    const base = `/repos/${owner}/${repo}`;
    const release = await client.request(`${base}/releases/latest`, {
        notFound: `${owner}/${repo} has no published GitHub release; cannot determine the latest release`,
    });
    const tag = release?.tag_name;
    if (typeof tag !== "string" || !tag) throw new Error(`${owner}/${repo} latest release has no tag name`);
    const commit = await client.request(`${base}/commits/${encodeURIComponent(tag)}`);
    if (typeof commit?.sha !== "string") throw new Error(`could not resolve ${owner}/${repo} tag ${tag} to a commit`);
    const latest = { base, owner, repo, tag, commit: commit.sha, publishedAt: release.published_at ?? null, newer: true };
    const id = `${owner}/${repo}`;
    if (tag === pinned.release) {
        if (commit.sha !== pinned.releaseCommit) {
            throw new Error(`${id} release ${tag} now points to ${commit.sha}, not the pinned ${pinned.releaseCommit}; review manually`);
        }
        return { ...latest, newer: false };
    }
    // A different tag must be provably newer: by version order when both tags are versions, and by ancestry when the commits differ.
    const order = compareReleaseTags(tag, pinned.release);
    if (order !== null && order <= 0) throw new Error(`${id} latest release ${tag} is not newer than pinned ${pinned.release}; review manually`);
    if (commit.sha === pinned.releaseCommit) {
        if (order === null) {
            throw new Error(`cannot establish whether ${id} release ${tag} is newer than pinned ${pinned.release}: both point to the same commit and the tags are not comparable versions`);
        }
        return latest;
    }
    const compare = await client.request(`${base}/compare/${pinned.releaseCommit}...${commit.sha}`);
    if (compare?.status !== "ahead") {
        throw new Error(`${id} latest release ${tag} is ${compare?.status ?? "unknown"} relative to pinned ${pinned.release}; review manually`);
    }
    return latest;
}

// Orders dotted numeric release tags such as 0.6.15 or v5.3.3; returns null when either tag is not of that form.
export function compareReleaseTags(a, b) {
    const parse = (tag) => /^v?(\d+(?:\.\d+)*)$/.exec(tag ?? "")?.[1].split(".").map(Number);
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return null;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const delta = (x[i] ?? 0) - (y[i] ?? 0);
        if (delta) return Math.sign(delta);
    }
    return 0;
}

/**
 * @param {{ manifestPath?: string, fetch?: typeof fetch, token?: string }} [options]
 */
export async function checkBundledSkillUpdates({ manifestPath = DEFAULT_MANIFEST, fetch = globalThis.fetch, token } = {}) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const root = dirname(manifestPath);
    const client = new GitHubClient({ fetch, token });
    const repositories = new Map();
    const results = [];
    for (const skill of manifest.skills ?? []) {
        const pinned = skill.upstream ?? {};
        const result = { name: skill.name, repository: pinned.repository, pinnedRelease: pinned.release, pinnedCommit: pinned.releaseCommit };
        try {
            const bundled = await readFile(join(root, skill.path), "utf8");
            result.bundledMatchesManifest = sha256Text(bundled) === skill.sha256;
            const key = JSON.stringify([pinned.repository, pinned.release, pinned.releaseCommit]);
            if (!repositories.has(key)) repositories.set(key, checkRepository(client, pinned.repository, pinned));
            const latest = await repositories.get(key);
            Object.assign(result, { latestRelease: latest.tag, latestCommit: latest.commit, publishedAt: latest.publishedAt, newerRelease: latest.newer });
            const upstream = await client.request(
                `${latest.base}/contents/${pinned.path.split("/").map(encodeURIComponent).join("/")}?ref=${latest.commit}`,
                { raw: true, notFound: `${pinned.path} does not exist in ${latest.owner}/${latest.repo} release ${latest.tag}` },
            );
            result.latestSha256 = sha256Text(upstream);
            result.contentChanged = result.latestSha256 !== skill.sha256;
            if (latest.newer) {
                result.status = result.contentChanged ? "update-available" : "newer-release-unchanged";
            } else if (result.contentChanged) {
                result.status = "error";
                result.error = `latest release ${latest.tag} is the pinned commit but its file does not match the manifest hash`;
            } else {
                result.status = "current";
            }
        } catch (error) {
            result.status = "error";
            result.error = error?.message ?? String(error);
        }
        if (result.bundledMatchesManifest === false && result.status !== "error") {
            result.status = "error";
            result.error = "bundled file does not match its manifest hash";
        }
        results.push(result);
    }
    const exitCode = results.some((r) => r.status === "error") ? 2
        : results.some((r) => r.status !== "current") ? 1 : 0;
    return { results, exitCode };
}

export function formatReport(results) {
    const lines = [];
    for (const r of results) {
        const head = `${r.name} (pinned ${r.pinnedRelease ?? "?"})`;
        switch (r.status) {
            case "current":
                lines.push(`${head}: up to date with latest release ${r.latestRelease}.`);
                break;
            case "newer-release-unchanged":
                lines.push(`${head}: newer release ${r.latestRelease} is available; skill content is unchanged.`);
                break;
            case "update-available":
                lines.push(`${head}: newer release ${r.latestRelease} is available and the skill content changed (sha256 ${r.latestSha256}).`);
                break;
            default:
                lines.push(`${head}: CHECK FAILED - ${r.error}`);
        }
    }
    return lines.join("\n");
}

async function main(argv) {
    const json = argv.includes("--json");
    const manifestArg = argv.find((a) => a.startsWith("--manifest="));
    const { results, exitCode } = await checkBundledSkillUpdates({
        manifestPath: manifestArg ? resolve(manifestArg.slice("--manifest=".length)) : DEFAULT_MANIFEST,
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
    });
    process.stdout.write(`${json ? JSON.stringify({ results, exitCode }, null, 2) : formatReport(results)}\n`);
    process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`Skill update check failed: ${error?.message ?? error}\n`);
        process.exitCode = 2;
    });
}
