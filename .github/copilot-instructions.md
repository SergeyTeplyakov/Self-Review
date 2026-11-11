# Starting work

Start new work from a freshly fetched `origin/main`, not stale local state or an
unmerged feature or pull-request branch. Verify that required prerequisite changes
are actually present on current main before implementing dependent work.

Preserve existing uncommitted changes. If a prerequisite is missing from main,
stop and ask before reapplying it; do not silently use its unmerged branch as the
base.
