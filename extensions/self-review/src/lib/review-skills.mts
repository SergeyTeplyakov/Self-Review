import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ReviewError } from "./review-service.mjs";
import type { SettingsStore } from "../../types/contracts.js";

export const REVIEW_SKILLS = ["code-review-and-quality", "code-simplification", "ponytail-review"];
export const BUNDLED_SKILLS_ROOT = new URL("../bundled-skills/", import.meta.url);

export interface BundledSkillManifestEntry {
    name: string;
    role: "review" | "ponytail";
    title: string;
    summary: string;
    path: string;
    sha256: string;
    upstream: { repository: string; release: string; releaseCommit: string; path: string; fileCommit: string };
    license: { spdx: string; files: string[] };
    modified: boolean;
    attribution?: string;
}

// What a run records: provenance of the bundled snapshot, never its content.
export interface RunSkill {
    name: string;
    role: "review" | "ponytail";
    bundled: true;
    release: string;
    releaseCommit: string;
    fileCommit: string;
    sha256: string;
}

export interface RunSkillWithContent extends RunSkill {
    content: string;
}

function selectedNames(value: unknown, message: string): string[] {
    if (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length
        || !value.every((name: unknown): name is string => typeof name === "string")) {
        throw new ReviewError("invalid_input", message);
    }
    return value;
}

// Older settings stored host installation names such as "plugin:code-simplification".
function canonical(names: string[]): string[] {
    return [...new Set(names.map((name) => name.split(":").at(-1) ?? name).filter((name) => REVIEW_SKILLS.includes(name)))];
}

// The review skills ship with Self-Review as pinned upstream snapshots, so no host skill API is involved.
export class ReviewSkills {
    private readonly store: SettingsStore;
    private readonly root: URL;
    private manifest?: Promise<BundledSkillManifestEntry[]>;

    constructor({ store, root = BUNDLED_SKILLS_ROOT }: { store: SettingsStore; root?: URL }) {
        this.store = store;
        this.root = root;
    }

    private entries(): Promise<BundledSkillManifestEntry[]> {
        this.manifest ??= readFile(new URL("manifest.json", this.root), "utf8").then((text) => {
            const skills = (JSON.parse(text) as { skills: BundledSkillManifestEntry[] }).skills;
            if (REVIEW_SKILLS.some((name) => !skills.some((skill) => skill.name === name))) {
                throw new ReviewError("conflict", "The bundled review skill manifest is incomplete.");
            }
            return REVIEW_SKILLS.map((name) => skills.find((skill) => skill.name === name)!);
        });
        return this.manifest;
    }

    // Unset defaults mean every bundled skill; a saved list, including [], is an explicit choice.
    private async defaults(): Promise<{ selected: string[]; saved: boolean }> {
        const saved = (await this.store.readSettings()).reviewSkills;
        if (saved === undefined) return { selected: [...REVIEW_SKILLS], saved: false };
        return { selected: canonical(selectedNames(saved, "Saved review skill choices are invalid.")), saved: true };
    }

    private validate(input: unknown): string[] {
        const names = selectedNames(input, "Select at most three distinct review skills.");
        const unknown = names.find((name) => !REVIEW_SKILLS.includes(name));
        if (unknown !== undefined) throw new ReviewError("invalid_input", `Unknown review skill ${unknown}. Choose from ${REVIEW_SKILLS.join(", ")}.`);
        return names;
    }

    async read(names?: unknown) {
        const defaults = await this.defaults();
        const selected = names === undefined ? defaults.selected : this.validate(names);
        const entries = await this.entries();
        return {
            bundled: true, scope: "Self-Review user preference", selected,
            defaults,
            skills: entries.map((entry) => ({
                name: entry.name, role: entry.role, title: entry.title, summary: entry.summary,
                upstream: entry.upstream, license: entry.license, modified: entry.modified,
                attribution: entry.attribution ?? null, sha256: entry.sha256,
                selected: selected.includes(entry.name),
            })),
        };
    }

    async update(input: unknown, { saveDefaults = true }: { saveDefaults?: boolean } = {}) {
        const names = this.validate(input);
        if (saveDefaults) await this.store.updateSettings((settings) => { settings.reviewSkills = names; });
        return this.read(names);
    }

    private async content(entry: BundledSkillManifestEntry): Promise<string> {
        const text = (await readFile(new URL(entry.path, this.root), "utf8")).replace(/\r\n/g, "\n");
        if (createHash("sha256").update(text).digest("hex") !== entry.sha256) {
            throw new ReviewError("conflict", `Bundled review skill ${entry.name} does not match its pinned snapshot. Reinstall Self-Review.`);
        }
        return text;
    }

    async forRun(names?: unknown): Promise<RunSkillWithContent[]> {
        const selected = names === undefined ? (await this.defaults()).selected : this.validate(names);
        const entries = (await this.entries()).filter((entry) => selected.includes(entry.name));
        return Promise.all(entries.map(async (entry) => ({
            name: entry.name, role: entry.role, bundled: true as const,
            release: entry.upstream.release, releaseCommit: entry.upstream.releaseCommit,
            fileCommit: entry.upstream.fileCommit, sha256: entry.sha256,
            content: await this.content(entry),
        })));
    }
}
