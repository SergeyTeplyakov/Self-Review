import { execFile } from "node:child_process";
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const STATES = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };
function oid(value) {
    return typeof value === "string" && OID.test(value) ? value : null;
}
function timestamp(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function refName(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
function matchingPullRequests(entries, branch) {
    if (!Array.isArray(entries))
        throw new Error("GitHub CLI returned an invalid pull request list.");
    return entries.flatMap((entry) => {
        if (entry?.headRefName !== branch || typeof entry.number !== "number" || !Number.isSafeInteger(entry.number) || entry.number < 1)
            return [];
        if (typeof entry.url !== "string")
            return [];
        const state = typeof entry.state === "string" ? STATES[entry.state.toUpperCase()] : undefined;
        if (!state)
            return [];
        let url;
        try {
            url = new URL(entry.url);
        }
        catch {
            return [];
        }
        const pathMatch = url.pathname.match(/^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/);
        if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash
            || !pathMatch || Number(pathMatch[1]) !== entry.number)
            return [];
        const mergeCommit = entry.mergeCommit && typeof entry.mergeCommit === "object" ? entry.mergeCommit.oid : null;
        return [{
                number: entry.number,
                url: url.href,
                state,
                baseRefName: refName(entry.baseRefName),
                headRefOid: oid(entry.headRefOid),
                mergedAt: state === "merged" ? timestamp(entry.mergedAt) : null,
                closedAt: timestamp(entry.closedAt),
                mergeCommitOid: state === "merged" ? oid(mergeCommit) : null,
            }];
    });
}
const latest = (prs, at) => prs.reduce((best, pr) => {
    if (!best)
        return pr;
    const a = at(pr) ?? "", b = at(best) ?? "";
    return a > b || (a === b && pr.number > best.number) ? pr : best;
}, null);
// An open pull request wins; otherwise the most recently merged, then the most recently closed one.
function selectPullRequest(matches, branch) {
    const open = matches.filter((pr) => pr.state === "open");
    if (open.length > 1)
        throw new Error(`More than one open pull request matches branch "${branch}".`);
    return open[0]
        ?? latest(matches.filter((pr) => pr.state === "merged"), (pr) => pr.mergedAt)
        ?? latest(matches.filter((pr) => pr.state === "closed"), (pr) => pr.closedAt);
}
export function findPullRequest(repoRoot, branch, run = execFile) {
    return new Promise((resolve, reject) => {
        run("gh", [
            "pr", "list", "--state", "all", "--head", branch, "--limit", "100",
            "--json", "number,url,headRefName,state,baseRefName,headRefOid,mergedAt,closedAt,mergeCommit",
        ], { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`Could not check the pull request with GitHub CLI: ${(stderr || error.message).trim()}`));
                return;
            }
            try {
                resolve(selectPullRequest(matchingPullRequests(JSON.parse(stdout), branch), branch));
            }
            catch (parseError) {
                reject(parseError);
            }
        });
    });
}
