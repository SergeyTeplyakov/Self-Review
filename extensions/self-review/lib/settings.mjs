// @ts-check
// Per-repository user settings, kept in the extension's user-local data and never written into the repository.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as gitDefault from "./git-process.mjs";
import { agentReviewDefaults, settingsPatch, isLearningMode, isDeliveryMode, LEARNING_MODES, DELIVERY_MODES } from "../web/contracts.mjs";
export { LEARNING_MODES, DELIVERY_MODES } from "../web/contracts.mjs";

// How the agent treats review feedback as reusable guidelines:
//   off     - address the comment only; never touch instruction files
//   suggest - propose guidelines in the thread and save one only after the reviewer approves it
//   auto    - save settled repository guidelines directly and report where they went
/** @type {import("../types/contracts.js").LearningMode} */
export const DEFAULT_LEARNING = "off";

// When the agent receives the reviewer's comments:
//   immediate - each comment is sent as soon as it is posted
//   batch     - comments wait as drafts until the reviewer submits them together
//   ask       - each review asks the reviewer to choose immediate or batch
/** @type {import("../types/contracts.js").DeliveryMode} */
export const DEFAULT_DELIVERY = "immediate";

// The delivery mode in effect for one review, or null while an ask-mode review is undecided.
/** @param {unknown} repoMode @param {{deliveryMode?: unknown} | null} [review]
 * @returns {import("../types/contracts.js").DeliveryChoice} */
export function resolveDelivery(repoMode, review) {
    const mode = isDeliveryMode(repoMode) ? repoMode : DEFAULT_DELIVERY;
    if (mode !== "ask") return mode;
    return review?.deliveryMode === "immediate" || review?.deliveryMode === "batch" ? review.deliveryMode : null;
}

/** @type {Record<string, string>} */
const DEFAULT_PORTS = { http: "80", https: "443", ssh: "22", "git+ssh": "22", "ssh+git": "22", git: "9418" };

// Hosts that match owner and repository names case-insensitively. Other servers may be case-sensitive,
// so their paths keep their case and a differently cased remote is asked about separately.
const CASE_INSENSITIVE_HOST = /^(?:(?:ssh\.)?github\.com|[^.]+\.ghe\.com|gitlab\.com|bitbucket\.org|(?:ssh\.)?dev\.azure\.com|(?:[^.]+\.)?visualstudio\.com)$/;

// Reduces equivalent remote spellings (https, ssh, scp-style, credentials, default port, .git) to host/owner/repo.
// A non-default port is kept, since it can name a different server.
/** @param {unknown} url */
export function normalizeRemoteUrl(url) {
    let value = String(url ?? "").trim().replace(/\\/g, "/");
    const scp = /^(?:([^@/\s]+)@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(value);
    if (scp && !value.includes("://")) {
        const [, user, host, remotePath] = scp;
        if (!CASE_INSENSITIVE_HOST.test(host.toLowerCase()) && !remotePath.startsWith("/")) {
            // On generic SSH servers this path is relative to this particular user's home.
            return `ssh-home:${user ?? ""}@${host.toLowerCase()}/${remotePath.replace(/\.git\/*$/i, "").replace(/\/+$/, "")}`;
        }
        value = `${host}/${remotePath.replace(/^\/+/, "")}`;
    } else {
        const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1].toLowerCase();
        value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "");
        value = value.replace(/^([^/:]+):(\d+)(?=\/|$)/, (all, host, port) => (scheme && DEFAULT_PORTS[scheme] === port ? host : all));
    }
    value = value.replace(/\.git\/*$/i, "").replace(/\/+$/, "");
    const slash = value.indexOf("/");
    const host = (slash < 0 ? value : value.slice(0, slash)).toLowerCase();
    const rest = slash < 0 ? "" : value.slice(slash);
    return host + (CASE_INSENSITIVE_HOST.test(host.replace(/:\d+$/, "")) ? rest.toLowerCase() : rest);
}

// Case-insensitive file systems (the Windows and macOS defaults) fold a path's case; others keep it.
/** @param {string} p @param {string} [platform] */
export function pathKey(p, platform = process.platform) {
    return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
}

// Git treats a URL without a scheme or an scp-style host as a local path, relative to the repository.
/** @param {string} url @param {string} repoRoot */
function localRemotePath(url, repoRoot) {
    const value = url.trim();
    if (/^file:\/\//i.test(value)) {
        try {
            return fileURLToPath(value);
        } catch {
            return path.resolve(repoRoot, decodeURIComponent(value.replace(/^file:\/\//i, "")));
        }
    }
    if (value.includes("://")) return null;
    if (/^(?:[^@/\\\s]+@)?[^:/\\\s]{2,}:/.test(value)) return null;
    return path.resolve(repoRoot, value);
}

/** @param {string} url */
function remoteName(url) {
    const cleaned = String(url).trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
    return cleaned.split(/[/:]/).pop() || cleaned;
}

// The origin remote identifies a repository so a setting follows it across branches and worktrees;
// without a remote the shared git directory stands in.
/** @param {string} repoRoot @param {import("../types/contracts.js").GitRunner} [git] */
export async function repoIdentity(repoRoot, git = gitDefault) {
    const remote = await git.runGit(repoRoot, ["config", "--get", "remote.origin.url"], { allowFail: true });
    const url = remote.ok ? remote.stdout.trim() : "";
    if (url) {
        const local = localRemotePath(url, repoRoot);
        if (local) return { key: `remote:file:${pathKey(local)}`, name: remoteName(url) };
        return { key: `remote:${normalizeRemoteUrl(url)}`, name: remoteName(url) };
    }
    const common = await git.runGit(repoRoot, ["rev-parse", "--git-common-dir"], { allowFail: true });
    const dir = common.ok ? common.stdout.trim() : "";
    const root = dir ? path.resolve(repoRoot, dir) : path.resolve(repoRoot);
    return { key: `local:${pathKey(root)}`, name: path.basename(repoRoot) };
}

export class SettingsService {
    /** @param {{store: import("../types/contracts.js").SettingsStore, git?: import("../types/contracts.js").GitRunner, log?: import("../types/contracts.js").Log}} options */
    constructor({ store, git = gitDefault, log = () => {} }) {
        this.store = store;
        this.git = git;
        this.log = log;
    }

    // Agent review defaults belong to the user, not a repository or canvas panel.
    async getAgentReview() {
        const defaults = (await this.store.readSettings()).agentReview;
        return defaults == null ? null : this.validateAgentReview(defaults);
    }

    /** @param {unknown} defaults */
    validateAgentReview(defaults) {
        return agentReviewDefaults(defaults);
    }

    /** @param {unknown} defaults */
    async updateAgentReview(defaults) {
        const value = defaults === null ? null : this.validateAgentReview(defaults);
        await this.store.updateSettings((settings) => {
            if (value === null) delete settings.agentReview;
            else settings.agentReview = value;
        });
        return value;
    }

    // Effective settings for a repository. Learning stays off until the reviewer chooses a mode,
    // and an unreadable settings file never blocks the review.
    /** @param {string} repoRoot @returns {Promise<import("../types/contracts.js").RepoSettings>} */
    async get(repoRoot) {
        const identity = await repoIdentity(repoRoot, this.git);
        /** @type {import("../types/contracts.js").StoredRepoSettings | null} */
        let entry = null;
        try {
            entry = (await this.store.readSettings()).repos?.[identity.key] ?? null;
        } catch (err) {
            this.log(`settings unreadable: ${err instanceof Error ? err.message : String(err)}`);
        }
        const configured = isLearningMode(entry?.learning);
        return {
            repoName: identity.name,
            learning: isLearningMode(entry?.learning) ? entry.learning : DEFAULT_LEARNING,
            delivery: isDeliveryMode(entry?.delivery) ? entry.delivery : DEFAULT_DELIVERY,
            configured,
            dismissed: entry?.promptDismissed === true,
        };
    }

    /** @param {string} repoRoot @param {unknown} [input] */
    async update(repoRoot, input = {}) {
        const patch = settingsPatch(input);
        const identity = await repoIdentity(repoRoot, this.git);
        await this.store.updateSettings((settings) => {
            const entry = { ...settings.repos[identity.key] };
            if (patch.learning !== undefined) entry.learning = patch.learning;
            if (patch.delivery !== undefined) entry.delivery = patch.delivery;
            if (patch.dismissed !== undefined) entry.promptDismissed = patch.dismissed;
            settings.repos[identity.key] = { ...entry, name: identity.name, updatedAt: new Date().toISOString() };
        });
        return this.get(repoRoot);
    }
}
