import { execFile } from "node:child_process";

interface PullRequestEntry {
    headRefName?: unknown;
    number?: unknown;
    url?: unknown;
}

interface PullRequest {
    number: number;
    url: string;
}

type ExecFileRunner = typeof execFile;

function matchingPullRequests(entries: unknown, branch: string): PullRequest[] {
    if (!Array.isArray(entries)) throw new Error("GitHub CLI returned an invalid pull request list.");
    return entries.flatMap((entry: PullRequestEntry) => {
        if (entry?.headRefName !== branch || typeof entry.number !== "number" || !Number.isSafeInteger(entry.number) || entry.number < 1) return [];
        if (typeof entry.url !== "string") return [];
        let url;
        try {
            url = new URL(entry.url);
        } catch {
            return [];
        }
        const pathMatch = url.pathname.match(/^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/);
        if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash
            || !pathMatch || Number(pathMatch[1]) !== entry.number) return [];
        return [{ number: entry.number, url: url.href }];
    });
}

export function findOpenPullRequest(repoRoot: string, branch: string, run: ExecFileRunner = execFile): Promise<PullRequest | null> {
    return new Promise((resolve, reject) => {
        run("gh", [
            "pr", "list", "--state", "open", "--head", branch, "--limit", "100",
            "--json", "number,url,headRefName",
        ], { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`Could not discover an open pull request with GitHub CLI: ${(stderr || error.message).trim()}`));
                return;
            }
            try {
                const matches = matchingPullRequests(JSON.parse(stdout), branch);
                if (matches.length > 1) throw new Error(`More than one open pull request matches branch "${branch}".`);
                resolve(matches[0] ?? null);
            } catch (parseError) {
                reject(parseError);
            }
        });
    });
}
