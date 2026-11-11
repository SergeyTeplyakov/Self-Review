# Starting work

Start new work from a freshly fetched `origin/main`, not stale local state or an
unmerged feature or pull-request branch. Verify that required prerequisite changes
are actually present on current main before implementing dependent work.

Preserve existing uncommitted changes. If a prerequisite is missing from main,
stop and ask before reapplying it; do not silently use its unmerged branch as the
base.

# Documentation

Every major feature must update `README.md` in the same change: describe what the
feature does, how to use it, and how it relates to existing features. Keep the
README faithful to the code and refresh affected screenshots when the UI they
show changes.
