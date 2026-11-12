import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { findOpenPullRequest } from "./modules.mjs";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const response = (entries: unknown[]): typeof execFile => (
    (command: string, args: readonly string[] | null | undefined, options: { cwd?: string } | null | undefined, callback: ExecFileCallback) => {
        assert.equal(command, "gh");
        assert.deepEqual(args, ["pr", "list", "--state", "open", "--head", "feature", "--limit", "100", "--json", "number,url,headRefName"]);
        assert.equal(options?.cwd, "C:\\repo");
        callback(null, JSON.stringify(entries), "");
    }
) as typeof execFile;

test("open pull request discovery uses GitHub CLI metadata for the exact branch", async () => {
    const result = await findOpenPullRequest("C:\\repo", "feature", response([
        { number: 7, url: "https://github.com/owner/repo/pull/7", headRefName: "feature" },
        { number: 8, url: "https://github.com/owner/repo/pull/8", headRefName: "another-branch" },
    ]));
    assert.deepEqual(result, { number: 7, url: "https://github.com/owner/repo/pull/7" });
});

test("pull request discovery returns no link for absent or invalid metadata", async () => {
    for (const entries of [
        [],
        [{ number: 7, url: "https://github.com/owner/repo/pull/7", headRefName: "another-branch" }],
        [{ number: 7, url: "http://github.com/owner/repo/pull/7", headRefName: "feature" }],
        [{ number: 8, url: "https://github.com/owner/repo/pull/7", headRefName: "feature" }],
        [{ number: 7, url: "https://github.com.evil.example/owner/repo/pull/7", headRefName: "feature" }],
    ]) {
        assert.equal(await findOpenPullRequest("C:\\repo", "feature", response(entries)), null);
    }
});

test("ambiguous pull request metadata and GitHub CLI errors fail explicitly", async () => {
    const entries = [
        { number: 7, url: "https://github.com/owner/repo/pull/7", headRefName: "feature" },
        { number: 8, url: "https://github.com/owner/repo/pull/8", headRefName: "feature" },
    ];
    await assert.rejects(findOpenPullRequest("C:\\repo", "feature", response(entries)), /More than one open pull request/);
    await assert.rejects(findOpenPullRequest("C:\\repo", "feature", (
        (_command: string, _args: readonly string[] | null | undefined, _options: { cwd?: string } | null | undefined, callback: ExecFileCallback) => {
            callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "authentication required");
        }
    ) as typeof execFile), /authentication required/);
});
