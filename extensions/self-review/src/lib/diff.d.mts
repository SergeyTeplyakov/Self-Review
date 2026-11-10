export interface DiffFile {
    path: string;
    oldPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
    [key: string]: unknown;
}

export interface DiffHunk {
    rows: DiffRow[];
    [key: string]: unknown;
}

export interface DiffRow {
    t: "ctx" | "del" | "add";
    o: number | null;
    n: number | null;
    s: string;
}

export function parseUnifiedDiff(text: string): DiffFile[];
export function synthesizeAddedFile(path: string, content: string): DiffFile;
export function hunkAnchorRange(hunk: DiffHunk): { side: "old" | "new"; startLine: number; endLine: number };
export function selectedLines(file: DiffFile, side: "old" | "new", startLine: number, endLine: number): string[];
export function hunkExcerpt(file: DiffFile, side: "old" | "new", startLine: number, endLine: number): { text: string } | null;
