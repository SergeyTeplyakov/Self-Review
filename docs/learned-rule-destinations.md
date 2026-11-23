# Learned rule destinations

Self-Review keeps learned repository rules beside the part of a repository they apply to, instead of assuming every rule belongs in the root `.github/copilot-instructions.md`. Personal rules keep their existing behavior and are saved to `~/.copilot/copilot-instructions.md`.

## Instruction roots and path mappings

A mapping connects a repository-relative path prefix to an instruction root. The reviewed file chooses the matching mapping with the longest prefix; an explicitly configured empty prefix is the repository-root default. The instruction root is a folder, not the final instruction file:

- General repository guidance goes to `<instruction-root>/.github/copilot-instructions.md`.
- Language-specific guidance goes to `<instruction-root>/.github/instructions/<language>.instructions.md`, with YAML front matter containing `applyTo`.

Mappings and their split setting are stored per user in Self-Review's existing settings store under `~/.copilot/extension-data/self-review`. The key is the repository identity from its `origin` remote, so the same map follows clones and worktrees of that repository. The settings file is outside the checkout and is never committed. Mapping paths are repository-relative; save-time checks reject traversal, symlink redirection, and non-regular instruction files.

## First use and saving

When `/learn` or another repository-rule proposal has no applicable mapping, its proposal card stays unsaved and asks for a destination. The card starts with a suggestion based on the reviewed file and the agent's language, `applyTo`, and instruction-file analysis. Confirm or edit the path prefix, instruction root, rule kind, language, and glob; Self-Review resolves the actual destination through the provider and displays it before saving. A language rule's `applyTo` must cover the reviewed file before it can be saved. Self-Review remembers the confirmed mapping for that path prefix only together with a successful save, and refuses the save before writing the rule if the new mapping would exceed the limit of 100 mappings per repository. If another window changed the stored mapping for that prefix after the card was shown, the save is refused, nothing is written, and the card shows the current mapping so you can review it and save again. It never silently falls back to the repository-root instruction file.

With **Auto-save learned rules** on, a proposal is still held if no mapping applies. A language rule that would create a new scoped instruction file is also held for confirmation; Self-Review does not create that file automatically. Before writing, Self-Review verifies the provider-resolved destination still matches the one shown for confirmation. Once the mapped destination is configured and confirmed, Self-Review saves the rule and reads it back before marking it saved. Manual saves use the same routing and verification as auto-save. Existing rule deduplication and file locking continue to apply.

## Split language-specific rules

Each mapping has **Split language-specific rules into scoped files**, on by default:

- **On:** For a language-specific rule, Self-Review uses only the exact `<language>.instructions.md` file under the mapped root's `.github/instructions`. If that file exists and its `applyTo` covers the reviewed file and every pattern in the rule's `applyTo`, Self-Review appends there. If it is missing, the proposal card asks you to confirm creating it with the suggested `applyTo`; topical files are not reused just because their `applyTo` matches. It does not write to ancestor or repository-root instruction files.
- If the exact language file exists but its `applyTo` does not cover the reviewed file or the rule's full `applyTo` (for example, the file lists `**/*.ts` and the rule asks for `**/*.ts,**/*.tsx`), Self-Review proposes a separate extension-specific file (for example, `typescript-tsx.instructions.md`) rather than silently narrowing the rule or broadening the existing file's scope.
- **Off:** Self-Review does not require the split. It appends to an existing instruction file under the mapped root whose `applyTo` covers the reviewed file and every pattern in the rule's `applyTo`, or uses that root's general instruction file when none does.
- **Repository-wide rules:** These always go to the mapped root's general instruction file, regardless of the split setting.

Existing scoped instruction files may use comma-separated `applyTo` globs; Self-Review matches any listed pattern and ignores a standard trailing YAML comment. As in VS Code, commas inside a brace group do not separate patterns, a group such as `**/*.{ts,tsx}` stands for each of its alternatives, and matching ignores case. A file covers a requested pattern when it lists the same pattern, a universal pattern (`**` or `**/*`), or a `**/` pattern the requested one narrows (for example, `**/*.ts` covers `src/**/*.ts`).

An ancestor instruction file can inform the agent's suggestion and help avoid duplicate guidance, but it is never a fallback destination for a mapped rule.

## Manage mappings

Open **Settings → Manual review settings** in the canvas. The **Repository instruction destinations** list lets you view, edit, add, or remove mappings and change the split setting per entry. Use an empty path prefix to configure a root-default mapping. Removing a mapping does not delete any instruction files already written; future proposals for that path remain unsaved until another mapping is configured.

## Example: ErrorProne.NET

ErrorProne.NET has C# source under `src/ErrorProne.NET.CoreAnalyzers` and a tracked root instruction file at `.github/instructions/csharp-documentation.instructions.md`. That file has `applyTo: "**/*.cs"`. A mapping can scope the C# analyzer project while retaining the repository's existing instruction root:

| Path prefix | Instruction root | Split |
| --- | --- | --- |
| `src/ErrorProne.NET.CoreAnalyzers` | repository root (empty) | On |

For a C# review comment under that project, Self-Review uses the longest matching prefix and proposes the exact `.github/instructions/csharp.instructions.md` destination. The existing `csharp-documentation.instructions.md` is not reused for unrelated C# guidance, even though its `applyTo` covers all C# files. If `csharp.instructions.md` is missing, Self-Review asks for confirmation before creating it with the suggested `applyTo`.
