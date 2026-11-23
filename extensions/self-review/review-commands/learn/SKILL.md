---
name: learn
description: Turn settled feedback into a reusable guideline.
---

# /learn

## Purpose

Distill the reviewer's settled feedback in this comment or earlier in this thread into one concise, actionable rule.

## When to use

Use the reviewed location and existing instructions to infer the narrowest reusable scope. For a class-specific layout correction, infer the supported convention for similar files or classes (for example, keep private members at the end of classes that follow this layout), not a one-off instruction about the named class or a universal rule across languages.

## Guardrails

Read existing instructions before choosing a rule and destination. Refine equivalent guidance instead of duplicating it. If the intent or applicability is unclear, ask in-thread; do not invent a preference. Suggest a destination from the reviewed file and existing instruction files, then let the reviewer confirm or edit it in the proposal card. Do not implement the local code change or edit the review description as part of `/learn`.

State the rule's applicability in the wording itself. Repository rules use the configured destination for the reviewed file; never assume a fixed repository instruction file or write directly to one. For each repository rule, include a destination suggestion in `lessons`: `pathPrefix` and `instructionRoot` inferred from the reviewed file and existing instructions, plus `kind: "general"` for repository-wide guidance or `kind: "language"`, `language`, and `applyTo` for language-specific guidance. Personal rules go to `{{personalFile}}`; choose personal scope only when the reviewer clearly intends it to apply across repositories.

## Auto-save off

Always post the reusable rule and its scope as a proposal. The reviewer can refine it in-thread or click **Save guideline** to persist the displayed wording and scope.

## Auto-save on

Always post the reusable rule and its scope. Self-Review saves only when a configured path mapping and a safe destination exist; otherwise it keeps the proposal and asks the reviewer to confirm a destination. Self-Review verifies every write; report the rule without claiming it was saved yourself.

## Reporting

For a new proposal, include the exact rule, scope, and sourceMessageId: {{messageId}} in `lessons`. To refine an existing proposal, use its `lessonId` and omit `sourceMessageId` so it stays linked to the original comment. Do not write instruction files or supply `savedTo`; Self-Review owns persistence.
