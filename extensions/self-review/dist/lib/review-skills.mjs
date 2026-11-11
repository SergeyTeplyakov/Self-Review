import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ReviewError } from "./review-service.mjs";
export const REVIEW_SKILLS = ["code-review-and-quality", "code-simplification", "ponytail-review"];
export const BUNDLED_SKILLS_ROOT = new URL("../bundled-skills/", import.meta.url);
function selectedNames(value, message) {
    if (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length
        || !value.every((name) => typeof name === "string")) {
        throw new ReviewError("invalid_input", message);
    }
    return value;
}
// Older settings stored host installation names such as "plugin:code-simplification".
function canonical(names) {
    return [...new Set(names.map((name) => name.split(":").at(-1) ?? name).filter((name) => REVIEW_SKILLS.includes(name)))];
}
// The review skills ship with Self-Review as pinned upstream snapshots, so no host skill API is involved.
export class ReviewSkills {
    store;
    root;
    manifest;
    constructor({ store, root = BUNDLED_SKILLS_ROOT }) {
        this.store = store;
        this.root = root;
    }
    entries() {
        this.manifest ??= readFile(new URL("manifest.json", this.root), "utf8").then((text) => {
            const skills = JSON.parse(text).skills;
            if (REVIEW_SKILLS.some((name) => !skills.some((skill) => skill.name === name))) {
                throw new ReviewError("conflict", "The bundled review skill manifest is incomplete.");
            }
            return REVIEW_SKILLS.map((name) => skills.find((skill) => skill.name === name));
        });
        return this.manifest;
    }
    // Unset defaults mean every bundled skill; a saved list, including [], is an explicit choice.
    async defaults() {
        const saved = (await this.store.readSettings()).reviewSkills;
        if (saved === undefined)
            return { selected: [...REVIEW_SKILLS], saved: false };
        return { selected: canonical(selectedNames(saved, "Saved review skill choices are invalid.")), saved: true };
    }
    validate(input) {
        const names = selectedNames(input, "Select at most three distinct review skills.");
        const unknown = names.find((name) => !REVIEW_SKILLS.includes(name));
        if (unknown !== undefined)
            throw new ReviewError("invalid_input", `Unknown review skill ${unknown}. Choose from ${REVIEW_SKILLS.join(", ")}.`);
        return names;
    }
    async read(names) {
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
    async update(input, { saveDefaults = true } = {}) {
        const names = this.validate(input);
        if (saveDefaults)
            await this.store.updateSettings((settings) => { settings.reviewSkills = names; });
        return this.read(names);
    }
    async content(entry) {
        const text = (await readFile(new URL(entry.path, this.root), "utf8")).replace(/\r\n/g, "\n");
        if (createHash("sha256").update(text).digest("hex") !== entry.sha256) {
            throw new ReviewError("conflict", `Bundled review skill ${entry.name} does not match its pinned snapshot. Reinstall Self-Review.`);
        }
        return text;
    }
    async forRun(names) {
        const selected = names === undefined ? (await this.defaults()).selected : this.validate(names);
        const entries = (await this.entries()).filter((entry) => selected.includes(entry.name));
        return Promise.all(entries.map(async (entry) => ({
            name: entry.name, role: entry.role, bundled: true,
            release: entry.upstream.release, releaseCommit: entry.upstream.releaseCommit,
            fileCommit: entry.upstream.fileCommit, sha256: entry.sha256,
            content: await this.content(entry),
        })));
    }
}
