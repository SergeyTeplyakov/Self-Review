import { appendFile, lstat, mkdir, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { ReviewError } from "../web/contracts.mjs";
const LANGUAGE_BY_EXTENSION = {
    cs: "csharp", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", py: "python", ps1: "powershell", go: "go",
    rs: "rust", java: "java", rb: "ruby", php: "php", sh: "shell", sql: "sql",
};
export function inferRuleDestination(filePath) {
    const extension = path.posix.extname(filePath.replace(/\\/g, "/")).slice(1).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    return language
        ? { kind: "language", language, applyTo: `**/*.${extension}` }
        : { kind: "general" };
}
function isMissing(error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function globRegex(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000\//g, "(?:.*/)?")
        .replace(/\u0000/g, ".*");
    return new RegExp(`^${escaped}$`);
}
function appliesTo(pattern, filePath) {
    const file = filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
    return globRegex(pattern.replace(/\\/g, "/")).test(file);
}
function applyToFrom(contents) {
    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)?.[1];
    const entry = frontMatter?.split(/\r?\n/).find((line) => /^\s*applyTo\s*:\s*/.test(line));
    const value = entry?.replace(/^\s*applyTo\s*:\s*/, "").trim();
    if (!value)
        return null;
    return value.replace(/^(['"])(.*)\1$/, "$2");
}
function safeRelativePath(value) {
    if (value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)
        || value.split("/").some((part) => part === "." || part === "..")) {
        throw new ReviewError("invalid_input", "The instruction mapping must stay inside the repository.");
    }
    return value ? value.split("/") : [];
}
async function ensureSafeDirectory(repoRoot, relative) {
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
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
            try {
                await mkdir(current);
            }
            catch (createError) {
                if (!createError || typeof createError !== "object" || !("code" in createError) || createError.code !== "EEXIST")
                    throw createError;
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
async function readInstructionFile(file) {
    try {
        const stat = await lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new ReviewError("invalid_input", "The instruction destination must be a regular file, not a symlink.");
        }
        return await readFile(file, "utf8");
    }
    catch (error) {
        if (isMissing(error))
            return null;
        throw error;
    }
}
async function matchingScopedFile(directory, filePath) {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    }
    catch (error) {
        if (isMissing(error))
            return null;
        throw error;
    }
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".instructions.md")).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        const contents = await readInstructionFile(file);
        const pattern = contents === null ? null : applyToFrom(contents);
        if (contents !== null && pattern && appliesTo(pattern, filePath))
            return { file, contents };
    }
    return null;
}
function validateDestination(destination) {
    if (destination.kind === "general")
        return destination;
    if (destination.kind !== "language" || !destination.language || !/^[a-z0-9][a-z0-9-]{0,39}$/i.test(destination.language)
        || !destination.applyTo || destination.applyTo.length > 240
        || /[\u0000-\u001f]/.test(destination.applyTo) || destination.applyTo.startsWith("/")) {
        throw new ReviewError("invalid_input", "A language-specific guideline needs a language and repository-relative applyTo pattern.");
    }
    return destination;
}
export async function saveRepositoryRule(repoRoot, mapping, reviewedPath, destinationInput, rule, confirmedNewFile, lock) {
    const destination = validateDestination(destinationInput);
    const instructionRoot = safeRelativePath(mapping.instructionRoot).join("/");
    const mappedRoot = await ensureSafeDirectory(repoRoot, instructionRoot);
    const rootLabel = instructionRoot ? `${instructionRoot}/` : "";
    const generalRelative = `${rootLabel}.github/copilot-instructions.md`;
    const scopedDirectoryRelative = `${rootLabel}.github/instructions`;
    const scopedDirectory = destination.kind === "language"
        ? await ensureSafeDirectory(repoRoot, scopedDirectoryRelative)
        : null;
    const scoped = destination.kind === "language" && !mapping.splitLanguageSpecific && scopedDirectory
        ? await matchingScopedFile(scopedDirectory, reviewedPath)
        : null;
    let file;
    let relativeFile;
    let contents;
    let createScopedFile = false;
    if (destination.kind === "language" && mapping.splitLanguageSpecific) {
        if (!scopedDirectory)
            throw new ReviewError("invalid_input", "The scoped instruction directory is unavailable.");
        if (scoped) {
            file = scoped.file;
            contents = scoped.contents;
            relativeFile = `${scopedDirectoryRelative}/${path.basename(file)}`;
        }
        else {
            const name = `${destination.language}.instructions.md`;
            file = path.join(scopedDirectory, name);
            relativeFile = `${scopedDirectoryRelative}/${name}`;
            contents = await readInstructionFile(file);
            if (contents === null) {
                createScopedFile = true;
            }
            else {
                const pattern = applyToFrom(contents);
                if (!pattern || !appliesTo(pattern, reviewedPath)) {
                    throw new ReviewError("conflict", `The existing ${relativeFile} does not apply to ${reviewedPath}.`);
                }
            }
        }
    }
    else if (destination.kind === "language" && scoped) {
        file = scoped.file;
        contents = scoped.contents;
        relativeFile = `${scopedDirectoryRelative}/${path.basename(file)}`;
    }
    else {
        file = path.join(mappedRoot, ".github", "copilot-instructions.md");
        relativeFile = generalRelative;
        const generalDirectory = await ensureSafeDirectory(repoRoot, `${rootLabel}.github`);
        file = path.join(generalDirectory, "copilot-instructions.md");
        contents = await readInstructionFile(file);
    }
    if (createScopedFile && !confirmedNewFile)
        return { savedTo: relativeFile, needsConfirmation: true };
    await lock(`guideline-file:${file}`, async () => {
        const current = await readInstructionFile(file);
        const text = current ?? contents ?? "";
        const containsRule = text.split(/\r?\n/).some((line) => line.trim().replace(/^(?:[-*+]|\d+\.)\s+/, "") === rule);
        if (!containsRule) {
            const newline = text.includes("\r\n") ? "\r\n" : "\n";
            if (createScopedFile && current === null) {
                await appendFile(file, `---${newline}applyTo: "${destination.applyTo}"${newline}---${newline}${newline}- ${rule}${newline}`, "utf8");
            }
            else {
                await appendFile(file, `${text ? (text.endsWith("\n") ? newline : newline + newline) : ""}- ${rule}${newline}`, "utf8");
            }
        }
        const saved = await readFile(file, "utf8");
        if (!saved.split(/\r?\n/).some((line) => line.trim().replace(/^(?:[-*+]|\d+\.)\s+/, "") === rule)) {
            throw new ReviewError("conflict", "Could not verify the saved guideline.");
        }
    });
    return { savedTo: relativeFile, needsConfirmation: false };
}
