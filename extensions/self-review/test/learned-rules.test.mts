import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveRepositoryRule } from "./modules.mjs";
import type { InstructionMapping } from "../types/contracts.js";

const noLock = async <T,>(_key: string, action: () => Promise<T>): Promise<T> => action();

async function fixture(t: import("node:test").TestContext): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "sr-rule-destination-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

const language = { kind: "language", language: "csharp", applyTo: "**/*.cs" } as const;

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

test("split-off routing uses a matching scoped file or the mapped root's general file", async (t) => {
    const repo = await fixture(t);
    const mapping: InstructionMapping = { pathPrefix: "src/Area", instructionRoot: "src/Area", splitLanguageSpecific: false };
    const general = path.join(repo, "src", "Area", ".github", "copilot-instructions.md");
    const saved = await saveRepositoryRule(repo, mapping, "src/Area/Rules.cs", language, "Keep branches shallow.", false, noLock);
    assert.equal(saved.savedTo, "src/Area/.github/copilot-instructions.md");
    assert.equal(await readFile(general, "utf8"), "- Keep branches shallow.\n");

    const scoped = path.join(repo, "src", "Area", ".github", "instructions", "csharp.instructions.md");
    await mkdir(path.dirname(scoped), { recursive: true });
    await writeFile(scoped, `---\napplyTo: "**/*.cs"\n---\n`);
    const routed = await saveRepositoryRule(repo, mapping, "src/Area/Rules.cs", language, "Use typed guards.", false, noLock);
    assert.equal(routed.savedTo, "src/Area/.github/instructions/csharp.instructions.md");
    assert.equal((await readFile(general, "utf8")).includes("Use typed guards."), false);
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
