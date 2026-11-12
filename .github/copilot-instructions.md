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

# Completing UI changes

A UI change is not finished until the user can see it. Before reporting it done:

1. Build and validate: run `npm run build`, `npm run typecheck`, and the
   relevant tests, and keep `dist` consistent with the sources.
2. Deploy only with authorization. Installing or replacing a user-wide extension
   (for example `~/.copilot/extensions/self-review`) changes every session, so
   do it only when the user has explicitly authorized it. Deploy reversibly: back
   up or record the prior installation, never modify an unrelated link target,
   and preserve stored reviews and settings.
3. Reload the provider (or ask the owner of the session to reload it) so the new
   build is actually served.
4. Open the canvas explicitly on the correct checkout, base, and scope (for
   example All changes against `origin/main`), never an empty or merged
   comparison.
5. Verify the change in the live UI, not just in tests or screenshots.
6. Let one session own the shared preview panel; do not reopen or retarget a
   panel another session is driving.
7. Disclose blockers: if any step cannot be completed, say which and why instead
   of claiming the live UI changed.

Completing a change never implies running paid agent reviews, pushing, opening or
merging a pull request, or publishing a release; each needs its own authorization.
