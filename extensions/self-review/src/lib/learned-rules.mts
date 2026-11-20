import { appendFile, lstat, mkdir, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import type { InstructionMapping } from "../../types/contracts.js";
import { ReviewError } from "../web/contracts.mjs";

export interface RuleDestination {
    kind: "general" | "language";
    language?: string;
    applyTo?: string;
    pathPrefix?: string;
    instructionRoot?: string;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    cs: "csharp", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", py: "python", ps1: "powershell", go: "go",
    rs: "rust", java: "java", rb: "ruby", php: "php", sh: "shell", sql: "sql",
};

export function inferRuleDestination(filePath: string): RuleDestination {
    const extension = path.posix.extname(filePath.replace(/\\/g, "/")).slice(1).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    return language
        ? { kind: "language", language, applyTo: `**/*.${extension}` }
        : { kind: "general" };
}

function isMissing(error: unknown): boolean {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function globRegex(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000\//g, "(?:.*/)?")
        .replace(/\u0000/g, ".*");
    return new RegExp(`^${escaped}$`);
}

function applyToPatterns(value: string): string[] {
    return value.split(",").map((pattern) => pattern.trim()).filter(Boolean);
}

function appliesTo(pattern: string | string[], filePath: string): boolean {
    const file = filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
    const patterns = typeof pattern === "string" ? applyToPatterns(pattern) : pattern;
    return patterns.some((item) => globRegex(item.replace(/\\/g, "/")).test(file));
}

function applyToFrom(contents: string): string[] | null {
    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)?.[1];
    const entry = frontMatter?.split(/\r?\n/).find((line) => /^\s*applyTo\s*:\s*/.test(line));
    let value = entry?.replace(/^\s*applyTo\s*:\s*/, "").trim();
    if (!value) return null;
    if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value.charAt(0);
        const closingQuote = value.indexOf(quote, 1);
        if (closingQuote <= 0 || (value.slice(closingQuote + 1).trim() && !/^\s+#/.test(value.slice(closingQuote + 1)))) return null;
        value = value.slice(1, closingQuote);
    } else {
        value = value.replace(/\s+#.*$/, "").trim();
    }
    const patterns = applyToPatterns(value);
    return patterns.length ? patterns : null;
}

function safeRelativePath(value: string): string[] {
    if (value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)
        || value.split("/").some((part) => part === "." || part === "..")) {
        throw new ReviewError("invalid_input", "The instruction mapping must stay inside the repository.");
    }
    return value ? value.split("/") : [];
}

async function ensureSafeDirectory(repoRoot: string, relative: string, create = true): Promise<string | null> {
    const root = await realpath(repoRoot);
    const parts = safeRelativePath(relative);
    let current = root;
    for (const part of parts) {
        current = path.join(current, part);
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new ReviewError("invalid_input", "The instruction destination must not redirect through a symlink.");
            }
        } catch (error) {
            if (!isMissing(error)) throw error;
            if (!create) return null;
            try {
                await mkdir(current);
            } catch (createError) {
                if (!createError || typeof createError !== "object" || !("code" in createError) || createError.code !== "EEXIST") throw createError;
            }
            const stat = await lstat(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new ReviewError("invalid_input", "The instruction destination must not redirect through a symlink.");
            }
        }
        const real = await realpath(current);
        if (path.relative(root, real).startsWith("..")) {
            throw new ReviewError("invalid_input", "The instruction destination must stay inside the repository.");
        }
    }
    return current;
}

async function readInstructionFile(file: string): Promise<string | null> {
    try {
        const stat = await lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new ReviewError("invalid_input", "The instruction destination must be a regular file, not a symlink.");
        }
        return await readFile(file, "utf8");
    } catch (error) {
        if (isMissing(error)) return null;
        throw error;
    }
}

async function matchingScopedFile(directory: string, filePath: string): Promise<{ file: string; contents: string } | null> {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (isMissing(error)) return null;
        throw error;
    }
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".instructions.md")).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        const contents = await readInstructionFile(file);
        const pattern = contents === null ? null : applyToFrom(contents);
        if (contents !== null && pattern && appliesTo(pattern, filePath)) return { file, contents };
    }
    return null;
}

function validateDestination(destination: RuleDestination): RuleDestination {
    if (destination.kind === "general") return destination;
    if (destination.kind !== "language" || !destination.language || !/^[a-z0-9][a-z0-9-]{0,39}$/i.test(destination.language)
        || !destination.applyTo || destination.applyTo.length > 240
        || /[\u0000-\u001f"\\]/.test(destination.applyTo) || destination.applyTo.startsWith("/")) {
        throw new ReviewError("invalid_input", "A language-specific guideline needs a language and a repository-relative applyTo pattern without quotes or backslashes.");
    }
    return destination;
}

interface ResolvedRuleDestination {
    file: string;
    savedTo: string;
    createScopedFile: boolean;
}

async function resolveRepositoryRuleDestination(
    repoRoot: string,
    mapping: InstructionMapping,
    reviewedPath: string,
    destinationInput: RuleDestination,
    createDirectories: boolean,
): Promise<ResolvedRuleDestination> {
    const destination = validateDestination(destinationInput);
    if (destination.kind === "language" && reviewedPath && !appliesTo(destination.applyTo!, reviewedPath)) {
        throw new ReviewError("invalid_input", `The applyTo pattern does not cover ${reviewedPath}.`);
    }
    const instructionRoot = safeRelativePath(mapping.instructionRoot).join("/");
    const rootLabel = instructionRoot ? `${instructionRoot}/` : "";
    const scopedDirectoryRelative = `${rootLabel}.github/instructions`;
    const scopedDirectory = destination.kind === "language"
        ? await ensureSafeDirectory(repoRoot, scopedDirectoryRelative, createDirectories)
        : null;
    const scoped = destination.kind === "language" && !mapping.splitLanguageSpecific && scopedDirectory
        ? await matchingScopedFile(scopedDirectory, reviewedPath)
        : null;
    let createScopedFile = false;

    if (destination.kind === "language" && mapping.splitLanguageSpecific) {
        const name = `${destination.language}.instructions.md`;
        const relativeFile = `${scopedDirectoryRelative}/${name}`;
        const file = path.join(repoRoot, ...safeRelativePath(relativeFile));
        const contents = scopedDirectory ? await readInstructionFile(file) : null;
        if (contents === null) {
            createScopedFile = true;
        } else {
            const pattern = applyToFrom(contents);
            if (!pattern || (reviewedPath && !appliesTo(pattern, reviewedPath))) {
                throw new ReviewError("conflict", `The existing ${relativeFile} does not apply to ${reviewedPath}.`);
            }
        }
        return { file, savedTo: relativeFile, createScopedFile };
    } else if (destination.kind === "language" && scoped) {
        return {
            file: scoped.file,
            savedTo: `${scopedDirectoryRelative}/${path.basename(scoped.file)}`,
            createScopedFile: false,
        };
    }

    const generalRelative = `${rootLabel}.github/copilot-instructions.md`;
    const generalDirectory = await ensureSafeDirectory(repoRoot, `${rootLabel}.github`, createDirectories);
    const file = path.join(repoRoot, ...safeRelativePath(generalRelative));
    if (generalDirectory) await readInstructionFile(file);
    return { file, savedTo: generalRelative, createScopedFile: false };
}

export async function previewRepositoryRuleDestination(
    repoRoot: string,
    mapping: InstructionMapping,
    reviewedPath: string,
    destination: RuleDestination,
): Promise<{ savedTo: string; needsConfirmation: boolean }> {
    const resolved = await resolveRepositoryRuleDestination(repoRoot, mapping, reviewedPath, destination, false);
    return { savedTo: resolved.savedTo, needsConfirmation: resolved.createScopedFile };
}

export async function saveRepositoryRule(
    repoRoot: string,
    mapping: InstructionMapping,
    reviewedPath: string,
    destination: RuleDestination,
    rule: string,
    confirmedNewFile: boolean,
    lock: <T>(key: string, action: () => Promise<T>) => Promise<T>,
    expectedSavedTo?: string,
): Promise<{ savedTo: string; needsConfirmation: boolean }> {
    const resolved = await resolveRepositoryRuleDestination(repoRoot, mapping, reviewedPath, destination, false);
    if (resolved.createScopedFile && !confirmedNewFile) return { savedTo: resolved.savedTo, needsConfirmation: true };
    if (expectedSavedTo !== undefined && expectedSavedTo !== resolved.savedTo) {
        throw new ReviewError("conflict", `The instruction destination changed to ${resolved.savedTo}. Review and confirm the updated destination.`);
    }
    const file = resolved.file;
    await lock(`guideline-file:${file}`, async () => {
        await ensureSafeDirectory(repoRoot, path.posix.dirname(resolved.savedTo));
        const current = await readInstructionFile(file);
        if (destination.kind === "language" && mapping.splitLanguageSpecific) {
            if (current === null && !resolved.createScopedFile) {
                throw new ReviewError("conflict", `The instruction destination changed to ${resolved.savedTo}. Review and confirm the updated destination.`);
            }
            if (current !== null) {
                const pattern = applyToFrom(current);
                if (!pattern || (reviewedPath && !appliesTo(pattern, reviewedPath))) {
                    throw new ReviewError("conflict", `The existing ${resolved.savedTo} does not apply to ${reviewedPath}.`);
                }
            }
        }
        const text = current ?? "";
        const containsRule = text.split(/\r?\n/).some((line) => line.trim().replace(/^(?:[-*+]|\d+\.)\s+/, "") === rule);
        if (!containsRule) {
            const newline = text.includes("\r\n") ? "\r\n" : "\n";
            if (resolved.createScopedFile && current === null) {
                await appendFile(file, `---${newline}applyTo: "${destination.applyTo}"${newline}---${newline}${newline}- ${rule}${newline}`, "utf8");
            } else {
                await appendFile(file, `${text ? (text.endsWith("\n") ? newline : newline + newline) : ""}- ${rule}${newline}`, "utf8");
            }
        }
        const saved = await readFile(file, "utf8");
        if (!saved.split(/\r?\n/).some((line) => line.trim().replace(/^(?:[-*+]|\d+\.)\s+/, "") === rule)) {
            throw new ReviewError("conflict", "Could not verify the saved guideline.");
        }
    });
    return { savedTo: resolved.savedTo, needsConfirmation: false };
}
