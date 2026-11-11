import { test } from "node:test";
import assert from "node:assert/strict";
import { findOpenPullRequest } from "../dist/lib/pull-request.mjs";

const response = (entries) => (command, args, options, callback) => {
    assert.equal(command, "gh");
    assert.deepEqual(args, ["pr", "list", "--state", "open", "--head", "feature", "--limit", "100", "--json", "number,url,headRefName"]);
    assert.equal(options.cwd, "C:\\repo");
    callback(null, JSON.stringify(entries), "");
};

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
    await assert.rejects(findOpenPullRequest("C:\\repo", "feature", (_command, _args, _options, callback) => {
        callback(new Error("exit 1"), "", "authentication required");
    }), /authentication required/);
});
