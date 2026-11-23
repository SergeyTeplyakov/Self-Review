# Starting work

Start new work from a freshly fetched `origin/main`, not stale local state or an
unmerged feature or pull-request branch. Verify that required prerequisite changes
are actually present on current main before implementing dependent work.

Preserve existing uncommitted changes. If a prerequisite is missing from main,
stop and ask before reapplying it; do not silently use its unmerged branch as the
base.

# Language

Use TypeScript for all handwritten implementation code, including the Node
provider, browser renderer, development scripts, screenshot tooling, and tests.
Include new code in the appropriate strict TypeScript project; do not substitute
declaration shims, unchecked JavaScript, or blanket type-check suppressions.

JavaScript is allowed only as generated distribution/build output, an unavoidable
platform discovery/bootstrap entry point (keep it minimal), or an unmodified
vendored third-party snapshot. Keep the host-facing ESM output and Node 22.12+
runtime compatibility; TypeScript execution must not require newer Node-only
type-stripping support. Commit generated `extensions/self-review/dist/` alongside
its sources.

# Documentation

Every major feature must update `README.md` in the same change: describe what the
feature does, how to use it, and how it relates to existing features. Keep the
README faithful to the code and refresh affected screenshots when the UI they
show changes.

# Verifying pushes and UI changes

After every push to a PR branch, run the checks in section 3 of
`.github/skills/create-pr/SKILL.md`. Before reporting a UI change done, run its
"Live build checks".

# Self-review

The agent coordinating a self-review follows [REVIEW.md](REVIEW.md), including
when the review starts from the canvas. In a read-only model run, report the
Spec and Standards checks without editing the Overview, worktree, or issues.

# Authorization

Completing a change never implies running paid agent reviews, pushing, opening or
merging a pull request, replacing or reloading the user-wide provider, or
publishing a release; each needs its own authorization. Invoking `create-pr`
authorizes the stages its resolved inputs allow.
