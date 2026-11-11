import { ReviewError } from "./review-service.mjs";
export const REVIEW_SKILLS = ["code-review-and-quality", "code-simplification", "ponytail-review"];
export const SKILLS_UPSTREAM = "https://github.com/addyosmani/agent-skills";
function selectedNames(value, message) {
    if (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length
        || !value.every((name) => typeof name === "string")) {
        throw new ReviewError("invalid_input", message);
    }
    return value;
}
// Discovery and activation stay with the host. This service never reads or writes skill files.
export class ReviewSkills {
    store;
    list;
    constructor({ store, list }) {
        this.store = store;
        this.list = list;
    }
    async read(names) {
        const selected = selectedNames(names ?? (await this.store.readSettings()).reviewSkills ?? [], "Saved review skill choices are invalid.");
        const { skills } = await this.list();
        return {
            upstream: SKILLS_UPSTREAM, license: "MIT", scope: "Self-Review user preference", selected,
            skills: REVIEW_SKILLS.map((name) => ({
                name,
                upstream: name === "ponytail-review" ? "https://github.com/DietrichGebert/ponytail" : SKILLS_UPSTREAM,
                installations: skills.filter((skill) => (skill.declaredName ?? skill.commandName ?? skill.name).split(":").at(-1) === name
                    || skill.name.split(":").at(-1) === name).map((skill) => ({
                    name: skill.name, enabled: skill.enabled === true, source: skill.source,
                    role: name === "ponytail-review" ? "ponytail" : "review",
                    path: skill.path ?? null, pluginName: skill.pluginName ?? null,
                    version: null, selected: selected.includes(skill.name),
                })),
            })),
        };
    }
    async update(input, { saveDefaults = true } = {}) {
        const names = selectedNames(input, "Select at most three distinct installed review skills.");
        const catalog = await this.read();
        const available = catalog.skills.flatMap((skill) => skill.installations);
        if (catalog.skills.some((skill) => skill.installations.filter((entry) => names.includes(entry.name)).length > 1)) {
            throw new ReviewError("invalid_input", "Select only one installation of each review skill.");
        }
        for (const name of names) {
            if (!available.some((skill) => skill.name === name && skill.enabled)) {
                throw new ReviewError("conflict", `Skill ${name} is unavailable or disabled in the host. Refresh the catalog.`);
            }
        }
        if (saveDefaults)
            await this.store.updateSettings((settings) => { settings.reviewSkills = names; });
        return this.read(names);
    }
    async forRun(names) {
        const selected = selectedNames(names ?? (await this.store.readSettings()).reviewSkills ?? [], "Saved review skill choices are invalid.");
        // An older host without skill discovery must still support reviews when no skills are selected.
        if (selected.length === 0)
            return [];
        const catalog = await this.read(selected);
        if (catalog.skills.some((skill) => skill.installations.filter((entry) => selected.includes(entry.name)).length > 1)) {
            throw new ReviewError("invalid_input", "Select only one installation of each review skill.");
        }
        const available = catalog.skills.flatMap((skill) => skill.installations);
        return selected.map((name) => {
            const skill = available.find((entry) => entry.name === name && entry.enabled);
            if (!skill)
                throw new ReviewError("conflict", `Selected review skill ${name} is unavailable or disabled. Change the review skill settings before running.`);
            return skill;
        });
    }
}
