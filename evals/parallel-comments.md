# Parallel comments: basic assessment

**Work in progress.** There is no automated evaluation of real Copilot answers
or edits yet. The automated tests below cover the provider; the live check
is a manual smoke test, not a quality score or a performance comparison.

**Mechanics.** From this checkout, run `npm run eval:parallel-comments` after
installing the locked dependencies. It runs locally or in CI without credentials.
It checks per-repository opt-in, read-only analysis in a shared checkout,
same-thread ordering, one coordinator edit at a time, and stale proposals. These
are fixture workers, not an assessment of Copilot's answers.

**Provider integration.** The same command and CI's `npm test` also exercise
the built extension in a disposable Git checkout. With the SDK host reporting
a busy turn, the test posts two independent comments through the canvas HTTP
API. It takes the first assignment and leaves it unfinished. The second must
wake the coordinator immediately, receive a free slot, and reply in its own
thread while the first still shows **processing**. Both threads must end with
exactly one reply. Only the host and its workers are simulated: this catches
provider wiring or scheduling regressions, not delays inside the desktop app.

**Live quality check.** Use a provider build containing the feature. Create a
fresh disposable Git repo under `.eval-work/` (ignored by the parent repo),
make an empty initial commit, then add two untracked files: `retry.json` with
`{"maxRetries":3}` and `label.txt` with `draft`. Open a **Pending** review of
the disposable repo itself so both files are in the review.

In that repo's **Settings → Manual review settings**, select **Batch** and
set **Comment processing → Concurrent comments** to **2**. Submit these two
comments together, each on its own file:

| Comment | What counts as a good result |
| --- | --- |
| On `retry.json`: `/explain How many retries does this setting allow?` | The reply says three **retries**, not three total attempts. The file is unchanged. |
| On `label.txt`: `Replace draft with ready in this file only and verify it.` | The reviewed file now reads `ready`, and its reply says what was checked. |

Pass only if both results are correct, each original thread gets exactly one
reply, and nothing else is changed or staged. If workers cannot analyze the
comments or the coordinator cannot edit the reviewed checkout, record **blocked**, not passed. This checks basic
usefulness, not a speedup or an improvement over serial. Set concurrency back
to **1 (serial)** to turn parallel processing off for that repo.
