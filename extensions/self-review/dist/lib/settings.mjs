// @ts-check
// Per-repository user settings, kept in the extension's user-local data and never written into the repository.
import path from "node:path";
import { readdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as gitDefault from "./git-process.mjs";
import { agentReviewDefaults, settingsPatch, isCommentConcurrency, isDeliveryMode, isRecord, ReviewError } from "../web/contracts.mjs";
export { DELIVERY_MODES } from "../web/contracts.mjs";
function storedAutoSave(entry) {
    if (typeof entry?.autoSaveLearnedRules === "boolean")
        return entry.autoSaveLearnedRules;
    if (entry?.learning === "auto")
        return true;
    if (entry?.learning === "off" || entry?.learning === "suggest")
        return false;
    return undefined;
}
function storedInstructionMappings(entry) {
    const value = entry?.instructionMappings;
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || !value.every((mapping) => isRecord(mapping)
        && typeof mapping.pathPrefix === "string" && typeof mapping.instructionRoot === "string"
        && typeof mapping.splitLanguageSpecific === "boolean")) {
        throw new ReviewError("invalid_input", "Stored instruction mappings are invalid.");
    }
    return value;
}
// When the agent receives the reviewer's comments:
//   immediate - each comment is sent as soon as it is posted
//   batch     - comments wait as drafts until the reviewer submits them together
//   ask       - each review asks the reviewer to choose immediate or batch
/** @type {import("../../types/contracts.js").DeliveryMode} */
export const DEFAULT_DELIVERY = "immediate";
// The delivery mode in effect for one review, or null while an ask-mode review is undecided.
/** @param {unknown} repoMode @param {{deliveryMode?: unknown} | null} [review]
 * @returns {import("../../types/contracts.js").DeliveryChoice} */
export function resolveDelivery(repoMode, review) {
    const mode = isDeliveryMode(repoMode) ? repoMode : DEFAULT_DELIVERY;
    if (mode !== "ask")
        return mode;
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
    }
    else {
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
/** @param {string} [platform] */
export function pathCaseSensitive(platform = process.platform) {
    return platform !== "win32" && platform !== "darwin";
}
/** @param {string} p @param {string} [platform] */
export function pathKey(p, platform = process.platform) {
    return pathCaseSensitive(platform) ? p : p.toLowerCase();
}
export function validateMappingPrefixes(mappings) {
    if (new Set(mappings.map((mapping) => pathKey(mapping.pathPrefix))).size !== mappings.length) {
        throw new ReviewError("invalid_input", "Instruction mapping path prefixes must be unique.");
    }
}
export function selectInstructionMapping(mappings, reviewedPath) {
    const file = pathKey(reviewedPath.replace(/\\/g, "/").replace(/^\.\/+/, ""));
    return [...mappings]
        .filter((mapping) => {
        const prefix = pathKey(mapping.pathPrefix);
        return !prefix || file === prefix || file.startsWith(`${prefix}/`);
    })
        .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0] ?? null;
}
// Git treats a URL without a scheme or an scp-style host as a local path, relative to the repository.
/** @param {string} url @param {string} repoRoot */
function localRemotePath(url, repoRoot) {
    const value = url.trim();
    if (/^file:\/\//i.test(value)) {
        try {
            return fileURLToPath(value);
        }
        catch {
            return path.resolve(repoRoot, decodeURIComponent(value.replace(/^file:\/\//i, "")));
        }
    }
    if (value.includes("://"))
        return null;
    if (/^(?:[^@/\\\s]+@)?[^:/\\\s]{2,}:/.test(value))
        return null;
    return path.resolve(repoRoot, value);
}
/** @param {string} url */
function remoteName(url) {
    const cleaned = String(url).trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
    return cleaned.split(/[/:]/).pop() || cleaned;
}
// The origin remote identifies a repository so a setting follows it across branches and worktrees;
// without a remote the shared git directory stands in.
/** @param {string} repoRoot @param {import("../../types/contracts.js").GitRunner} [git] */
async function resolveRepoIdentity(repoRoot, git) {
    const remote = await git.runGit(repoRoot, ["config", "--get", "remote.origin.url"], { allowFail: true });
    const url = remote.ok ? remote.stdout.trim() : "";
    if (url) {
        const local = localRemotePath(url, repoRoot);
        if (local)
            return { key: `remote:file:${pathKey(local)}`, name: remoteName(url) };
        return { key: `remote:${normalizeRemoteUrl(url)}`, name: remoteName(url) };
    }
    const common = await git.runGit(repoRoot, ["rev-parse", "--git-common-dir"], { allowFail: true });
    const dir = common.ok ? common.stdout.trim() : "";
    const root = dir ? path.resolve(repoRoot, dir) : path.resolve(repoRoot);
    let nameRoot = repoRoot;
    if (dir) {
        const worktree = await git.runGit(repoRoot, ["--git-dir", root, "config", "--path", "--default", "", "--get", "core.worktree"], { allowFail: true });
        const configured = worktree.ok ? worktree.stdout.trim() : "";
        if (configured)
            nameRoot = path.resolve(root, configured);
        else {
            const bare = await git.runGit(repoRoot, ["--git-dir", root, "rev-parse", "--is-bare-repository"], { allowFail: true });
            if (bare.ok && bare.stdout.trim() === "true")
                nameRoot = root;
            else if (path.basename(root) === ".git" && root === path.resolve(repoRoot, ".git"))
                nameRoot = path.dirname(root);
        }
    }
    const name = path.basename(nameRoot);
    return { key: `local:${pathKey(root)}`, name, localPath: root };
}
export async function repoIdentity(repoRoot, git = gitDefault) {
    const { key, name } = await resolveRepoIdentity(repoRoot, git);
    return { key, name };
}
function missingPath(error) {
    return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
async function legacyLocalPaths(key) {
    const stored = key.slice("local:".length);
    if (stored.includes("\0"))
        throw new Error("Stored repository settings path contains a null character.");
    if (process.platform !== "darwin")
        return { paths: [await realpath(stored)] };
    const absolute = path.resolve(stored);
    const root = path.parse(absolute).root;
    let candidates = [root];
    let recoveryError;
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
        const next = [];
        for (const parent of candidates) {
            try {
                for (const name of await readdir(parent)) {
                    if (pathKey(name) === pathKey(part))
                        next.push(path.join(parent, name));
                }
            }
            catch (error) {
                if (!missingPath(error))
                    recoveryError ??= error;
            }
        }
        if (next.length > 128)
            throw new ReviewError("conflict", "A legacy repository settings path has too many case-equivalent matches.");
        candidates = next;
        if (!candidates.length)
            return { paths: [], error: recoveryError };
    }
    const resolved = [];
    for (const candidate of candidates) {
        try {
            resolved.push(await realpath(candidate));
        }
        catch (error) {
            if (!missingPath(error))
                recoveryError ??= error;
        }
    }
    return { paths: [...new Set(resolved)], error: recoveryError };
}
async function settingsKey(settings, identity, log) {
    if (!identity.localPath)
        return { key: identity.key, existingKey: identity.key };
    const physical = await realpath(identity.localPath);
    const target = process.platform === "darwin" ? physical : pathKey(physical);
    const canonical = `${process.platform === "darwin" ? "local-real:" : "local:"}${target}`;
    const matches = [];
    for (const candidate of Object.keys(settings.repos)) {
        const isPhysical = candidate.startsWith("local-real:");
        if (!isPhysical && !candidate.startsWith("local:"))
            continue;
        if (candidate === canonical || (process.platform !== "darwin" && candidate === identity.key)) {
            matches.push(candidate);
            continue;
        }
        try {
            const recovery = isPhysical ? { paths: [await realpath(candidate.slice("local-real:".length))] } : await legacyLocalPaths(candidate);
            const { paths, error } = recovery;
            const resolved = paths.map((value) => process.platform === "darwin" ? value : pathKey(value));
            if (resolved.includes(target)) {
                if (error)
                    throw new ReviewError("conflict", "A legacy repository settings path could not be fully resolved; resolve the settings entry before changing it.");
                if (new Set(resolved).size > 1)
                    throw new ReviewError("conflict", "A legacy repository settings path is ambiguous; resolve the settings entries before changing them.");
                matches.push(candidate);
            }
            if (error)
                log(`Could not resolve a stored repository settings path: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        catch (error) {
            if (error instanceof ReviewError && error.code === "conflict")
                throw error;
            if (missingPath(error))
                continue;
            log(`Could not resolve a stored repository settings path: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
    }
    if (matches.length > 1)
        throw new ReviewError("conflict", "Multiple settings entries refer to the same repository; resolve them before changing settings.");
    return { key: canonical, existingKey: matches[0] ?? canonical };
}
export class SettingsService {
    store;
    git;
    log;
    constructor({ store, git = gitDefault, log = () => { } }) {
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
        if (value && value.models.length < 2)
            throw new ReviewError("invalid_input", "Choose at least two reviewers for unanimous agent review.");
        await this.store.updateSettings((settings) => {
            if (value === null)
                delete settings.agentReview;
            else
                settings.agentReview = value;
        });
        return value;
    }
    // An unreadable settings file never enables automatic writes.
    /** @param {string} repoRoot @returns {Promise<import("../../types/contracts.js").RepoSettings>} */
    async get(repoRoot) {
        const identity = await resolveRepoIdentity(repoRoot, this.git);
        let entry = null;
        let settings = null;
        try {
            settings = await this.store.readSettings();
        }
        catch (err) {
            this.log(`settings unreadable: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (settings)
            entry = settings.repos[(await settingsKey(settings, identity, this.log)).existingKey] ?? null;
        const autoSave = storedAutoSave(entry);
        const instructionMappings = storedInstructionMappings(entry);
        return {
            repoName: identity.name,
            autoSaveLearnedRules: autoSave ?? false,
            delivery: isDeliveryMode(entry?.delivery) ? entry.delivery : DEFAULT_DELIVERY,
            instructionMappings,
            ...(instructionMappings.length ? { pathCaseSensitive: pathCaseSensitive() } : {}),
            ...(isCommentConcurrency(entry?.commentConcurrency) ? { commentConcurrency: entry.commentConcurrency } : {}),
            configured: autoSave !== undefined,
            dismissed: entry?.promptDismissed === true,
        };
    }
    /** @param {string} repoRoot @param {unknown} [input] */
    async update(repoRoot, input = {}) {
        const patch = settingsPatch(input);
        const identity = await resolveRepoIdentity(repoRoot, this.git);
        await this.store.updateSettings(async (settings) => {
            const { key, existingKey } = await settingsKey(settings, identity, this.log);
            const entry = { ...settings.repos[existingKey] };
            const autoSave = patch.autoSaveLearnedRules ?? storedAutoSave(entry);
            if (autoSave !== undefined) {
                entry.autoSaveLearnedRules = autoSave;
                delete entry.learning;
            }
            if (patch.delivery !== undefined)
                entry.delivery = patch.delivery;
            if (patch.commentConcurrency === 1)
                delete entry.commentConcurrency;
            else if (patch.commentConcurrency !== undefined)
                entry.commentConcurrency = patch.commentConcurrency;
            if (patch.dismissed !== undefined)
                entry.promptDismissed = patch.dismissed;
            if (patch.instructionMappings !== undefined) {
                validateMappingPrefixes(patch.instructionMappings);
                if (patch.expectedInstructionMappings !== undefined
                    && JSON.stringify(storedInstructionMappings(entry)) !== JSON.stringify(patch.expectedInstructionMappings)) {
                    throw new ReviewError("conflict", "Repository instruction mappings changed while Settings was open. Reopen Settings and reapply the changes.");
                }
                entry.instructionMappings = patch.instructionMappings;
            }
            settings.repos[key] = { ...entry, name: identity.name, updatedAt: new Date().toISOString() };
            if (existingKey !== key)
                delete settings.repos[existingKey];
        });
        return this.get(repoRoot);
    }
    async updateInstructionMappings(repoRoot, update) {
        const identity = await resolveRepoIdentity(repoRoot, this.git);
        await this.store.updateSettings(async (settings) => {
            const { key, existingKey } = await settingsKey(settings, identity, this.log);
            const entry = { ...settings.repos[existingKey] };
            const mappings = await update(storedInstructionMappings(entry));
            validateMappingPrefixes(mappings);
            entry.instructionMappings = settingsPatch({ instructionMappings: mappings }).instructionMappings;
            settings.repos[key] = { ...entry, name: identity.name, updatedAt: new Date().toISOString() };
            if (existingKey !== key)
                delete settings.repos[existingKey];
        });
    }
    async withInstructionMappings(repoRoot, action) {
        return this.store.lock("settings", async () => action((await this.get(repoRoot)).instructionMappings));
    }
}
