export interface CommitEntry {
    commit: string;
    subject: string;
    author: string;
    date: string;
}

export function listCommits(repoRoot: string, offset?: number): Promise<{
    commits: CommitEntry[];
    nextOffset: number | null;
}>;
