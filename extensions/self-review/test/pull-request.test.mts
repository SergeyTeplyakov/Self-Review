import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { findPullRequest } from "./modules.mjs";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);

const response = (entries: unknown[]): typeof execFile => (
    (command: string, args: readonly string[] | null | undefined, options: { cwd?: string } | null | undefined, callback: ExecFileCallback) => {
        assert.equal(command, "gh");
        assert.deepEqual(args, [
            "pr", "list", "--state", "all", "--head", "feature", "--limit", "100",
            "--json", "number,url,headRefName,state,baseRefName,headRefOid,mergedAt,closedAt,mergeCommit",
        ]);
        assert.equal(options?.cwd, "C:\\repo");
        callback(null, JSON.stringify(entries), "");
    }
) as typeof execFile;

const entry = (number: number, state: string, extra: Record<string, unknown> = {}) => ({
    number, url: `https://github.com/owner/repo/pull/${number}`, headRefName: "feature", state,
    baseRefName: "main", headRefOid: HEAD, mergedAt: null, closedAt: null, mergeCommit: null, ...extra,
});

test("pull request discovery uses GitHub CLI metadata for the exact branch", async () => {
    const result = await findPullRequest("C:\\repo", "feature", response([
        entry(7, "OPEN"),
        { ...entry(8, "OPEN"), headRefName: "another-branch" },
    ]));
    assert.deepEqual(result, {
        number: 7, url: "https://github.com/owner/repo/pull/7", state: "open", baseRefName: "main",
        headRefOid: HEAD, mergedAt: null, closedAt: null, mergeCommitOid: null,
    });
});

test("an open pull request wins; otherwise the latest merged, then the latest closed one", async () => {
    const merged = (number: number, at: string) => entry(number, "MERGED", { mergedAt: at, closedAt: at, mergeCommit: { oid: MERGE } });
    const closed = (number: number, at: string) => entry(number, "CLOSED", { closedAt: at });
    const pick = async (entries: unknown[]) => (await findPullRequest("C:\\repo", "feature", response(entries)))?.number;

    assert.equal(await pick([merged(3, "2026-01-02T00:00:00Z"), entry(9, "OPEN"), closed(5, "2026-01-03T00:00:00Z")]), 9);
    assert.equal(await pick([merged(3, "2026-01-02T00:00:00Z"), merged(4, "2026-01-01T00:00:00Z"), closed(5, "2026-01-03T00:00:00Z")]), 3);
    assert.equal(await pick([closed(5, "2026-01-01T00:00:00Z"), closed(6, "2026-01-03T00:00:00Z")]), 6);

    const result = await findPullRequest("C:\\repo", "feature", response([merged(3, "2026-01-02T10:00:00+02:00")]));
    assert.equal(result?.state, "merged");
    assert.equal(result?.mergedAt, "2026-01-02T08:00:00.000Z");
    assert.equal(result?.mergeCommitOid, MERGE);
});

test("pull request discovery returns no link for absent or invalid metadata", async () => {
    for (const entries of [
        [],
        [{ ...entry(7, "OPEN"), headRefName: "another-branch" }],
        [{ ...entry(7, "OPEN"), url: "http://github.com/owner/repo/pull/7" }],
        [{ ...entry(8, "OPEN"), url: "https://github.com/owner/repo/pull/7" }],
        [{ ...entry(7, "OPEN"), url: "https://github.com.evil.example/owner/repo/pull/7" }],
        [entry(7, "DRAFTED")],
    ]) {
        assert.equal(await findPullRequest("C:\\repo", "feature", response(entries)), null);
    }
    const sanitized = await findPullRequest("C:\\repo", "feature", response([
        entry(7, "MERGED", { headRefOid: "not-an-oid", mergedAt: "yesterday", baseRefName: "main\u0007", mergeCommit: { oid: 42 } }),
    ]));
    assert.deepEqual(sanitized && [sanitized.headRefOid, sanitized.mergedAt, sanitized.baseRefName, sanitized.mergeCommitOid], [null, null, null, null]);
});

test("ambiguous open pull requests and GitHub CLI errors fail explicitly", async () => {
    await assert.rejects(findPullRequest("C:\\repo", "feature", response([entry(7, "OPEN"), entry(8, "OPEN")])), /More than one open pull request/);
    await assert.rejects(findPullRequest("C:\\repo", "feature", (
        (_command: string, _args: readonly string[] | null | undefined, _options: { cwd?: string } | null | undefined, callback: ExecFileCallback) => {
            callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "authentication required");
        }
    ) as typeof execFile), /authentication required/);
});
