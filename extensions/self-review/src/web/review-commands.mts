export const REVIEW_COMMANDS = [
    { name: "explain", description: "Explain the selected review context without editing it." },
    { name: "learn", description: "Turn settled feedback into a reusable guideline." },
] as const;

export type ReviewCommand = typeof REVIEW_COMMANDS[number]["name"];

export function parseReviewCommand(body: string): { name: ReviewCommand; argument: string } | null {
    const text = body.trim();
    const command = REVIEW_COMMANDS.find(({ name }) => text === `/${name}` || new RegExp(`^/${name}\\s`).test(text));
    return command ? { name: command.name, argument: text.slice(command.name.length + 1).trim() } : null;
}

export function reviewCommandSuggestions(draft: string) {
    const prefix = draft.trimStart();
    return /^\/[a-z]*$/.test(prefix) ? REVIEW_COMMANDS.filter(({ name }) => name.startsWith(prefix.slice(1))) : [];
}
