import { readFileSync } from "node:fs";
import { parseReviewCommand } from "../web/review-commands.mjs";
export function reviewCommandGuidance(body, messageId, autoSave, repoFile, personalFile) {
    const command = parseReviewCommand(body);
    if (!command)
        return [];
    const heading = `Built-in review skill /${command.name} for user comment ${JSON.stringify(messageId)}. Follow this skill instead of the generic instructions for this comment.`;
    const markdown = readFileSync(new URL(`../review-commands/${command.name}/SKILL.md`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const sections = new Map([...markdown.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)]
        .map(([, title, content]) => [title, content.trim()]));
    const shared = ["Purpose", "When to use", "Guardrails"];
    const names = command.name === "explain" ? shared : [...shared, autoSave ? "Auto-save on" : "Auto-save off", "Reporting"];
    const values = { repoFile, personalFile, messageId: JSON.stringify(messageId) };
    return [heading, ...names.map((name) => {
            const content = sections.get(name);
            if (!content)
                throw new Error(`Missing section "${name}" in /${command.name} SKILL.md.`);
            return content.replace(/\{\{(repoFile|personalFile|messageId)\}\}/g, (_placeholder, key) => values[key]);
        })];
}
