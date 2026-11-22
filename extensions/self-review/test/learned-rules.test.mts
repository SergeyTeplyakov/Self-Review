import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inferRuleDestination, previewRepositoryRuleDestination, saveRepositoryRule } from "./modules.mjs";
import type { InstructionMapping } from "../types/contracts.js";

const noLock = async <T,>(_key: string, action: () => Promise<T>): Promise<T> => action();

async function fixture(t: import("node:test").TestContext): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "sr-rule-destination-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

const language = { kind: "language", language: "csharp", applyTo: "**/*.cs" } as const;

test("TypeScript module extensions infer language-specific destinations", () => {
    assert.deepEqual(inferRuleDestination("src/Rules.mts"), {
        kind: "language", language: "typescript", applyTo: "**/*.mts",
    });
    assert.deepEqual(inferRuleDestination("src/Rules.cts"), {
        kind: "language", language: "typescript", applyTo: "**/*.cts",
    });
});

test("split routing prefers the exact language file over topical applyTo matches", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "src/Analyzer", instructionRoot: "src/Analyzer", splitLanguageSpecific: true };
    const instructions = path.join(repo, "src", "Analyzer", ".github", "instructions");
    const topical = path.join(instructions, "csharp-style.instructions.md");
    const exact = path.join(instructions, "csharp.instructions.md");
    await mkdir(instructions, { recursive: true });
    await writeFile(topical, `---\napplyTo: "**/*.cs"\n---\n\n# Style\n`);
    await writeFile(exact, `---\napplyTo: "**/*.cs"\n---\n\n# C#\n`);

    const first = await saveRepositoryRule(repo, mapping, "src/Analyzer/Rules/Check.cs", language, "Use explicit guards.", false, noLock);
    const second = await saveRepositoryRule(repo, mapping, "src/Analyzer/Rules/Check.cs", language, "Use explicit guards.", false, noLock);
    assert.deepEqual(first, { savedTo: "src/Analyzer/.github/instructions/csharp.instructions.md", needsConfirmation: false });
    assert.equal(second.savedTo, first.savedTo);
    assert.equal((await readFile(exact, "utf8")).match(/Use explicit guards\./g)?.length, 1);
    assert.equal((await readFile(topical, "utf8")).includes("Use explicit guards."), false);
});

test("split routing holds creation of the exact language file despite topical applyTo matches", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true };
    const topical = path.join(repo, ".github", "instructions", "csharp-documentation.instructions.md");
    const file = path.join(repo, ".github", "instructions", "csharp.instructions.md");
    await mkdir(path.dirname(topical), { recursive: true });
    await writeFile(topical, `---\napplyTo: "**/*.cs"\n---\n\n# Documentation\n`);

    const proposal = await saveRepositoryRule(repo, mapping, "src/Rules.cs", language, "Prefer explicit checks.", false, noLock);
    assert.deepEqual(proposal, { savedTo: ".github/instructions/csharp.instructions.md", needsConfirmation: true });
    await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal((await readFile(topical, "utf8")).includes("Prefer explicit checks."), false);

    const saved = await saveRepositoryRule(repo, mapping, "src/Rules.cs", language, "Prefer explicit checks.", true, noLock);
    assert.deepEqual(saved, { savedTo: ".github/instructions/csharp.instructions.md", needsConfirmation: false });
    assert.equal(await readFile(file, "utf8"), `---\napplyTo: "**/*.cs"\n---\n\n- Prefer explicit checks.\n`);
});

test("split routing proposes extension-specific files when the exact language file does not apply", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true };
    const instructions = path.join(repo, ".github", "instructions");
    await mkdir(instructions, { recursive: true });

    for (const scenario of [
        { language: "typescript", existingExtension: "ts", reviewedExtension: "tsx" },
        { language: "javascript", existingExtension: "js", reviewedExtension: "jsx" },
    ]) {
        const canonical = path.join(instructions, `${scenario.language}.instructions.md`);
        const variant = path.join(instructions, `${scenario.language}-${scenario.reviewedExtension}.instructions.md`);
        const reviewedPath = `src/Component.${scenario.reviewedExtension}`;
        const destination = inferRuleDestination(reviewedPath);
        await writeFile(canonical, `---\napplyTo: "**/*.${scenario.existingExtension}"\n---\n`);

        assert.deepEqual(
            await previewRepositoryRuleDestination(repo, mapping, reviewedPath, destination),
            { savedTo: `.github/instructions/${scenario.language}-${scenario.reviewedExtension}.instructions.md`, needsConfirmation: true },
        );
        assert.deepEqual(
            await saveRepositoryRule(repo, mapping, reviewedPath, destination, "Use explicit guards.", false, noLock),
            { savedTo: `.github/instructions/${scenario.language}-${scenario.reviewedExtension}.instructions.md`, needsConfirmation: true },
        );
        await assert.rejects(readFile(variant), { code: "ENOENT" });

        assert.deepEqual(
            await saveRepositoryRule(repo, mapping, reviewedPath, destination, "Use explicit guards.", true, noLock),
            { savedTo: `.github/instructions/${scenario.language}-${scenario.reviewedExtension}.instructions.md`, needsConfirmation: false },
        );
        assert.equal(await readFile(variant, "utf8"), `---\napplyTo: "**/*.${scenario.reviewedExtension}"\n---\n\n- Use explicit guards.\n`);
    }
});

test("held and stale destinations do not create instruction directories", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "src/Area", instructionRoot: "src/Area", splitLanguageSpecific: true };
    const file = path.join(repo, "src", "Area", ".github", "instructions", "csharp.instructions.md");

    assert.deepEqual(
        await saveRepositoryRule(repo, mapping, "src/Area/Rules.cs", language, "Use explicit checks.", false, noLock),
        { savedTo: "src/Area/.github/instructions/csharp.instructions.md", needsConfirmation: true },
    );
    await assert.rejects(lstat(path.join(repo, "src")), { code: "ENOENT" });
    await assert.rejects(
        saveRepositoryRule(repo, mapping, "src/Area/Rules.cs", language, "Use explicit checks.", true, noLock, "wrong/destination.md"),
        /destination changed/,
    );
    await assert.rejects(lstat(file), { code: "ENOENT" });
});

test("split-off routing uses a matching scoped file or the mapped root's general file", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "src/Area", instructionRoot: "src/Area", splitLanguageSpecific: false };
    const general = path.join(repo, "src", "Area", ".github", "copilot-instructions.md");
    const saved = await saveRepositoryRule(repo, mapping, "src/Area/Rules.cs", language, "Keep branches shallow.", false, noLock);
    assert.equal(saved.savedTo, "src/Area/.github/copilot-instructions.md");
    assert.equal(await readFile(general, "utf8"), "- Keep branches shallow.\n");

    const scoped = path.join(repo, "src", "Area", ".github", "instructions", "csharp-documentation.instructions.md");
    await mkdir(path.dirname(scoped), { recursive: true });
    await writeFile(scoped, `---\napplyTo: "**/*.cs"\n---\n`);
    assert.deepEqual(
        await previewRepositoryRuleDestination(repo, mapping, "src/Area/Rules.cs", language),
        { savedTo: "src/Area/.github/instructions/csharp-documentation.instructions.md", needsConfirmation: false },
    );
    const routed = await saveRepositoryRule(repo, mapping, "src/Area/Rules.cs", language, "Use typed guards.", false, noLock);
    assert.equal(routed.savedTo, "src/Area/.github/instructions/csharp-documentation.instructions.md");
    assert.equal((await readFile(general, "utf8")).includes("Use typed guards."), false);
});

test("split-off routing matches comma-separated applyTo patterns with trailing YAML comments", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: false };
    const file = path.join(repo, ".github", "instructions", "typescript-guidance.instructions.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `---\napplyTo: "**/*.ts,**/*.tsx" # TypeScript sources\n---\n`);

    assert.deepEqual(
        await previewRepositoryRuleDestination(repo, mapping, "src/View.tsx", { kind: "language", language: "typescript", applyTo: "**/*.tsx" }),
        { savedTo: ".github/instructions/typescript-guidance.instructions.md", needsConfirmation: false },
    );
    const saved = await saveRepositoryRule(repo, mapping, "src/View.tsx", { kind: "language", language: "typescript", applyTo: "**/*.tsx" }, "Prefer typed props.", false, noLock);
    assert.equal(saved.savedTo, ".github/instructions/typescript-guidance.instructions.md");
    assert.match(await readFile(file, "utf8"), /- Prefer typed props\./);
});

test("brace groups in applyTo expand to alternatives instead of splitting at their commas", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: false };
    const instructions = path.join(repo, ".github", "instructions");
    const file = path.join(instructions, "typescript-guidance.instructions.md");
    await mkdir(instructions, { recursive: true });
    await writeFile(file, `---\napplyTo: "**/*.{ts,tsx},docs/**/*.md"\n---\n`);
    const braced = { kind: "language", language: "typescript", applyTo: "**/*.{ts,tsx}" } as const;

    assert.deepEqual(
        await previewRepositoryRuleDestination(repo, mapping, "src/View.tsx", { kind: "language", language: "typescript", applyTo: "**/*.tsx" }),
        { savedTo: ".github/instructions/typescript-guidance.instructions.md", needsConfirmation: false },
    );
    const saved = await saveRepositoryRule(repo, mapping, "src/View.ts", braced, "Prefer typed props.", false, noLock);
    assert.equal(saved.savedTo, ".github/instructions/typescript-guidance.instructions.md");
    assert.match(await readFile(file, "utf8"), /- Prefer typed props\./);

    await writeFile(file, `---\napplyTo: "**/*.ts"\n---\n`);
    assert.deepEqual(
        await previewRepositoryRuleDestination(repo, mapping, "src/View.ts", braced),
        { savedTo: ".github/copilot-instructions.md", needsConfirmation: false },
        "a file covering only one brace alternative would narrow the rule",
    );
});

test("an existing scoped file is chosen only when its applyTo covers the rule's full applyTo", async (t) => {
    const repo = await fixture(t);
    const instructions = path.join(repo, ".github", "instructions");
    const broad = { kind: "language", language: "typescript", applyTo: "**/*.ts,**/*.tsx" } as const;
    await mkdir(instructions, { recursive: true });

    const off: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: false };
    const topical = path.join(instructions, "typescript-guidance.instructions.md");
    await writeFile(topical, `---\napplyTo: "**/*.ts"\n---\n`);
    assert.deepEqual(
        await previewRepositoryRuleDestination(repo, off, "src/View.ts", broad),
        { savedTo: ".github/copilot-instructions.md", needsConfirmation: false },
        "a file that covers only part of the rule's applyTo would silently narrow it",
    );
    assert.deepEqual(
        await previewRepositoryRuleDestination(repo, off, "src/View.ts", { kind: "language", language: "typescript", applyTo: "src/**/*.ts" }),
        { savedTo: ".github/instructions/typescript-guidance.instructions.md", needsConfirmation: false },
        "a broader file pattern covers a narrower requested one",
    );
    await rm(topical);

    const on: InstructionMapping = { ...off, splitLanguageSpecific: true };
    const canonical = path.join(instructions, "typescript.instructions.md");
    await writeFile(canonical, `---\napplyTo: "**/*.ts"\n---\n`);
    assert.deepEqual(
        await saveRepositoryRule(repo, on, "src/View.ts", broad, "Prefer typed props.", false, noLock),
        { savedTo: ".github/instructions/typescript-ts.instructions.md", needsConfirmation: true },
    );
    assert.equal(await readFile(canonical, "utf8"), `---\napplyTo: "**/*.ts"\n---\n`);
});

test("split-off save rejects a selected scoped file narrowed below the rule's applyTo while waiting for the lock", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: false };
    const destination = { kind: "language", language: "typescript", applyTo: "**/*.ts,**/*.tsx" } as const;
    const file = path.join(repo, ".github", "instructions", "typescript-guidance.instructions.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `---\napplyTo: "**/*.ts,**/*.tsx"\n---\n`);
    const competingWriter = async <T,>(_key: string, action: () => Promise<T>): Promise<T> => {
        await writeFile(file, `---\napplyTo: "**/*.ts"\n---\n`);
        return action();
    };

    await assert.rejects(
        saveRepositoryRule(repo, mapping, "src/View.ts", destination, "Prefer typed props.", false, competingWriter),
        /does not apply to src\/View\.ts with applyTo "\*\*\/\*\.ts,\*\*\/\*\.tsx"/,
    );
    assert.equal(await readFile(file, "utf8"), `---\napplyTo: "**/*.ts"\n---\n`);
});

test("split-off save rejects a selected scoped file whose applyTo changed while waiting for the lock", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: false };
    const file = path.join(repo, ".github", "instructions", "csharp-documentation.instructions.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `---\napplyTo: "**/*.cs"\n---\n`);
    const competingWriter = async <T,>(_key: string, action: () => Promise<T>): Promise<T> => {
        await writeFile(file, `---\napplyTo: "**/*.ts"\n---\n`);
        return action();
    };

    await assert.rejects(
        saveRepositoryRule(repo, mapping, "src/Rules.cs", language, "Use explicit guards.", false, competingWriter),
        /does not apply to src\/Rules\.cs/,
    );
    assert.equal(await readFile(file, "utf8"), `---\napplyTo: "**/*.ts"\n---\n`);
});

test("split-off save rejects a selected scoped file deleted while waiting for the lock", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: false };
    const file = path.join(repo, ".github", "instructions", "csharp-documentation.instructions.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `---\napplyTo: "**/*.cs"\n---\n`);
    const competingWriter = async <T,>(_key: string, action: () => Promise<T>): Promise<T> => {
        await rm(file);
        return action();
    };

    await assert.rejects(
        saveRepositoryRule(repo, mapping, "src/Rules.cs", language, "Use explicit guards.", false, competingWriter),
        /destination changed/,
    );
    await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("a concurrent scoped-file creator cannot bypass applyTo validation", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true };
    const file = path.join(repo, ".github", "instructions", "csharp.instructions.md");
    const competingWriter = async <T,>(_key: string, action: () => Promise<T>): Promise<T> => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `---\napplyTo: "**/*.ts"\n---\n`);
        return action();
    };

    await assert.rejects(
        saveRepositoryRule(repo, mapping, "src/Rules.cs", language, "Keep guards explicit.", true, competingWriter),
        /does not apply to src\/Rules\.cs/,
    );
    assert.equal(await readFile(file, "utf8"), `---\napplyTo: "**/*.ts"\n---\n`);
});

test("language applyTo must cover the reviewed path before a scoped file can be created", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true };
    const destination = { ...language, applyTo: "**/*.ts" };
    await assert.rejects(
        saveRepositoryRule(repo, mapping, "src/View.tsx", destination, "Use explicit guards.", true, noLock),
        /applyTo pattern does not cover/,
    );
    await assert.rejects(readFile(path.join(repo, ".github", "instructions", "csharp.instructions.md")), { code: "ENOENT" });
});

test("language applyTo rejects YAML quote and backslash characters", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true };
    for (const applyTo of ['**/rule".cs', "src\\*.cs"]) {
        await assert.rejects(
            saveRepositoryRule(repo, mapping, "src/Rules.cs", { ...language, applyTo }, "Use explicit guards.", true, noLock),
            /applyTo pattern without quotes or backslashes/,
        );
    }
    await assert.rejects(readFile(path.join(repo, ".github", "instructions", "csharp.instructions.md")), { code: "ENOENT" });
});

test("saving refuses when the provider-resolved destination changed after confirmation", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: false };
    const preview = await previewRepositoryRuleDestination(repo, mapping, "src/Rules.cs", language);
    assert.deepEqual(preview, { savedTo: ".github/copilot-instructions.md", needsConfirmation: false });

    const scoped = path.join(repo, ".github", "instructions", "csharp-documentation.instructions.md");
    await mkdir(path.dirname(scoped), { recursive: true });
    await writeFile(scoped, `---\napplyTo: "**/*.cs"\n---\n`);
    await assert.rejects(
        saveRepositoryRule(repo, mapping, "src/Rules.cs", language, "Use explicit guards.", false, noLock, preview.savedTo),
        /destination changed/,
    );
    assert.equal((await readFile(scoped, "utf8")).includes("Use explicit guards."), false);
    await assert.rejects(readFile(path.join(repo, ".github", "copilot-instructions.md")), { code: "ENOENT" });
});

test("repository mapping paths reject traversal and symlink redirection", async (t) => {
    const repo = await fixture(t);
    const traversal: InstructionMapping = { pathPrefix: "", instructionRoot: "../outside", splitLanguageSpecific: true };
    await assert.rejects(saveRepositoryRule(repo, traversal, "Rules.cs", language, "Do not escape.", true, noLock), /stay inside the repository/);

    const outside = await fixture(t);
    const github = path.join(repo, ".github");
    try {
        await symlink(outside, github, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
            t.skip("Directory symlink creation requires Windows Developer Mode or administrator rights.");
            return;
        }
        throw error;
    }
    const rootMapping: InstructionMapping = { pathPrefix: "", instructionRoot: "", splitLanguageSpecific: false };
    await assert.rejects(saveRepositoryRule(repo, rootMapping, "Rules.txt", { kind: "general" }, "Do not redirect.", true, noLock), /symlink/);
    await assert.rejects(readFile(path.join(outside, "copilot-instructions.md")), { code: "ENOENT" });
});
