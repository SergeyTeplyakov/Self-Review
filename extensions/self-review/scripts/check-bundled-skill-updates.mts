#!/usr/bin/env node
// Read-only check of bundled review skills against the latest published upstream
// GitHub releases. Never modifies the bundle. Exit codes: 0 = every skill is on
// the latest release, 1 = a newer release exists, 2 = a check could not complete.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../extensions/self-review/scripts");
export const DEFAULT_MANIFEST = resolve(here, "../bundled-skills/manifest.json");
const API = "https://api.github.com";

interface PinnedRelease {
    repository: string;
    release: string;
    releaseCommit: string;
    path: string;
}

interface BundledSkill {
    name: string;
    path: string;
    sha256: string;
    upstream?: Partial<PinnedRelease>;
}

interface BundleManifest {
    skills?: BundledSkill[];
}

interface CheckOptions {
    manifestPath?: string;
    fetch?: typeof fetch;
    token?: string;
}

interface SkillResult {
    name: string;
    repository: string | undefined;
    pinnedRelease: string | undefined;
    pinnedCommit: string | undefined;
    bundledMatchesManifest?: boolean;
    latestRelease?: string;
    latestCommit?: string;
    publishedAt?: string | null;
    newerRelease?: boolean;
    latestSha256?: string;
    contentChanged?: boolean;
    status?: "current" | "newer-release-unchanged" | "update-available" | "error";
    error?: string;
}

interface LatestRelease {
    base: string;
    owner: string;
    repo: string;
    tag: string;
    commit: string;
    publishedAt: string | null;
    newer: boolean;
}

interface RequestOptions {
    raw?: boolean;
    notFound?: string;
}

export const sha256Text = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

function parseRepository(url: string | undefined) {
    const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url ?? "");
    if (!match) throw new Error(`unsupported upstream repository URL: ${url}`);
    return { owner: match[1], repo: match[2] };
}

class GitHubClient {
    readonly fetch: typeof fetch;
    readonly token: string | undefined;

    constructor({ fetch, token }: { fetch: typeof globalThis.fetch; token?: string }) {
        this.fetch = fetch;
        this.token = token;
    }

    async request(path: string, options: RequestOptions & { raw: true }): Promise<string>;
    async request(path: string, options?: RequestOptions): Promise<unknown>;
    async request(path: string, { raw = false, notFound }: RequestOptions = {}): Promise<string | unknown> {
        const headers: Record<string, string> = {
            Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
            "User-Agent": "self-review-skill-update-check",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        let response;
        try {
            response = await this.fetch(`${API}${path}`, { headers });
        } catch (error) {
            throw new Error(`network error for ${path}: ${error instanceof Error ? error.message : String(error)}`);
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

async function checkRepository(client: GitHubClient, repository: string, pinned: PinnedRelease): Promise<LatestRelease> {
    const { owner, repo } = parseRepository(repository);
    const base = `/repos/${owner}/${repo}`;
    const releaseResult = await client.request(`${base}/releases/latest`, {
        notFound: `${owner}/${repo} has no published GitHub release; cannot determine the latest release`,
    });
    if (!releaseResult || typeof releaseResult !== "object") throw new Error(`${owner}/${repo} latest release has an invalid response`);
    const release = releaseResult as Record<string, unknown>;
    const tag = release.tag_name;
    if (typeof tag !== "string" || !tag) throw new Error(`${owner}/${repo} latest release has no tag name`);
    const commitResult = await client.request(`${base}/commits/${encodeURIComponent(tag)}`);
    if (!commitResult || typeof commitResult !== "object" || typeof (commitResult as Record<string, unknown>).sha !== "string") {
        throw new Error(`could not resolve ${owner}/${repo} tag ${tag} to a commit`);
    }
    const commit = (commitResult as { sha: string }).sha;
    const latest: LatestRelease = {
        base, owner, repo, tag, commit,
        publishedAt: typeof release.published_at === "string" ? release.published_at : null,
        newer: true,
    };
    const id = `${owner}/${repo}`;
    if (tag === pinned.release) {
        if (commit !== pinned.releaseCommit) {
            throw new Error(`${id} release ${tag} now points to ${commit}, not the pinned ${pinned.releaseCommit}; review manually`);
        }
        return { ...latest, newer: false };
    }
    // A different tag must be provably newer: by version order when both tags are versions, and by ancestry when the commits differ.
    const order = compareReleaseTags(tag, pinned.release);
    if (order !== null && order <= 0) throw new Error(`${id} latest release ${tag} is not newer than pinned ${pinned.release}; review manually`);
    if (commit === pinned.releaseCommit) {
        if (order === null) {
            throw new Error(`cannot establish whether ${id} release ${tag} is newer than pinned ${pinned.release}: both point to the same commit and the tags are not comparable versions`);
        }
        return latest;
    }
    const compareResult = await client.request(`${base}/compare/${pinned.releaseCommit}...${commit}`);
    const compareStatus = compareResult && typeof compareResult === "object"
        ? (compareResult as Record<string, unknown>).status
        : undefined;
    if (compareStatus !== "ahead") {
        throw new Error(`${id} latest release ${tag} is ${typeof compareStatus === "string" ? compareStatus : "unknown"} relative to pinned ${pinned.release}; review manually`);
    }
    return latest;
}

// Orders dotted numeric release tags such as 0.6.15 or v5.3.3; returns null when either tag is not of that form.
export function compareReleaseTags(a: string | undefined, b: string | undefined): number | null {
    const parse = (tag: string | undefined) => /^v?(\d+(?:\.\d+)*)$/.exec(tag ?? "")?.[1].split(".").map(Number);
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
export async function checkBundledSkillUpdates(
    { manifestPath = DEFAULT_MANIFEST, fetch = globalThis.fetch, token }: CheckOptions = {},
) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BundleManifest;
    const root = dirname(manifestPath);
    const client = new GitHubClient({ fetch, token });
    const repositories = new Map();
    const results: SkillResult[] = [];
    for (const skill of manifest.skills ?? []) {
        const pinned = skill.upstream;
        const result: SkillResult = {
            name: skill.name,
            repository: pinned?.repository,
            pinnedRelease: pinned?.release,
            pinnedCommit: pinned?.releaseCommit,
        };
        try {
            if (!pinned?.repository || !pinned.release || !pinned.releaseCommit || !pinned.path) {
                throw new Error(`Missing upstream pin for ${skill.name}`);
            }
            const upstreamPin: PinnedRelease = {
                repository: pinned.repository,
                release: pinned.release,
                releaseCommit: pinned.releaseCommit,
                path: pinned.path,
            };
            const bundled = await readFile(join(root, skill.path), "utf8");
            result.bundledMatchesManifest = sha256Text(bundled) === skill.sha256;
            const key = JSON.stringify([pinned.repository, pinned.release, pinned.releaseCommit]);
            if (!repositories.has(key)) repositories.set(key, checkRepository(client, pinned.repository, upstreamPin));
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
        } catch (error: unknown) {
            result.status = "error";
            result.error = error instanceof Error ? error.message : String(error);
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

export function formatReport(results: SkillResult[]) {
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

async function main(argv: string[]) {
    const json = argv.includes("--json");
    const manifestArg = argv.find((argument) => argument.startsWith("--manifest="));
    const { results, exitCode } = await checkBundledSkillUpdates({
        manifestPath: manifestArg ? resolve(manifestArg.slice("--manifest=".length)) : DEFAULT_MANIFEST,
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
    });
    process.stdout.write(`${json ? JSON.stringify({ results, exitCode }, null, 2) : formatReport(results)}\n`);
    process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch((error: unknown) => {
        process.stderr.write(`Skill update check failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
    });
}
